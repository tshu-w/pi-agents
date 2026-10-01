import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, lockKeys, reserve, reserveKeys } from './ownership.mjs';
import { rootPaths } from './paths.mjs';
import { getBackgroundWorkerStatus, isBackgroundWorker, waitForWorkerExit } from './background.mjs';

// Pi reloads extension modules but keeps the SessionManager. Retain its lease
// across reload without allowing a different manager to borrow ownership.
const leases = globalThis[Symbol.for('pi-agents.extension-ownership')] ??= new WeakMap();
const pending = globalThis[Symbol.for('pi-agents.pending-ownership')] ??= new Map();

async function waitAndReserve(paths, file, id, error, signal) {
  if (!id || error.code !== 'SESSION_OCCUPIED' || !error.owner || error.sessionId.startsWith('admission:')) throw error;
  const keys = lockKeys(file, id);
  const admission = reserveKeys(paths.ownership, file, keys.map(key => `admission:${key}`));
  try {
    signal.throwIfAborted();
    try {
      await getBackgroundWorkerStatus(paths.worker(id), { sessionId: id, sessionFile: file, ownerPid: error.owner.pid, signal });
    } catch (failure) {
      if (!['ENOENT', 'ECONNREFUSED', 'CONNECTION_CLOSED'].includes(failure.code)) throw failure;
      // A closing Worker has already removed its socket but still owns its file.
      if (error.owner.background !== true) return reserveKeys(paths.ownership, file, keys);
    }
    await waitForWorkerExit(error.owner.pid, { signal });
    signal.throwIfAborted();
    return reserveKeys(paths.ownership, file, keys);
  } finally { admission.release(); }
}

function readId(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry) continue;
    return entry.type === 'session' && typeof entry.id === 'string' ? entry.id : undefined;
  }
}

/**
 * Holds the current Session's ownership so one runtime uses a Session at a time.
 * An occupied Session is quarantined; /resume waits for a background Worker to exit.
 */
export default function ownershipExtension(pi, runtime = {}) {
  const paths = rootPaths();
  const stateDir = paths.ownership;
  let blocked = 'Session ownership has not been acquired';
  let reopen;
  let replacing = false;
  let alive = true;
  let waiting;
  const pendingKey = file => `${stateDir}\n${canonicalPath(file)}`;
  function savePending(file, id, lease) {
    const key = pendingKey(file);
    const value = { id, lease };
    pending.set(key, value);
    return value;
  }
  function discardPending(file, value) {
    if (pending.get(pendingKey(file)) !== value) return;
    pending.delete(pendingKey(file));
    value.lease.release();
  }

  function notify(ctx, message) {
    if (ctx.hasUI) ctx.ui.notify(message, 'error');
    else console.error(message);
  }

  pi.registerCommand('agents-reopen-internal', {
    description: 'Finish a pending background Session handover (internal)',
    handler: async (_args, ctx) => {
      if (!reopen) return;
      const { file, value } = reopen;
      reopen = undefined;
      replacing = true;
      try {
        const result = await ctx.switchSession(file);
        if (result.cancelled) {
          notify(ctx, 'Session handover reload was cancelled.');
          blocked = undefined;
        }
      } catch (error) {
        notify(ctx, error.message);
        blocked = undefined;
      } finally {
        replacing = false;
        discardPending(file, value);
      }
    },
  });

  function scheduleReopen() {
    // Session replacement must run from a command, after the current hooks.
    setTimeout(() => {
      if (alive && reopen) pi.sendUserMessage('/agents-reopen-internal', { expandPromptTemplates: true });
    }, 0);
  }

  pi.on('session_start', async (event, ctx) => {
    const manager = ctx.sessionManager;
    const file = manager.getSessionFile();
    try {
      if (file && !leases.has(manager)) {
        const transfer = pending.get(pendingKey(file));
        if (event.reason === 'resume' && transfer?.id === manager.getSessionId()) {
          pending.delete(pendingKey(file));
          leases.set(manager, transfer.lease);
        } else {
          // Target loading has already happened. A takeover here would leave
          // stale shutdown writers attached to the same Session file.
          leases.set(manager, reserve(stateDir, file, manager.getSessionId(), isBackgroundWorker(ctx)));
        }
      }
      if (runtime.start) await runtime.start(ctx);
      blocked = undefined;
    } catch (error) {
      blocked = error.message;
      notify(ctx, blocked);
      // A thrown session_start error is swallowed by Pi. Explicitly quarantine
      // normal input/tool execution while the host performs graceful shutdown.
      ctx.shutdown();
    }
  });

  pi.on('session_before_switch', (event, ctx) => {
    if (blocked && !replacing) return { cancel: true };
    if (event.reason !== 'resume' || !event.targetSessionFile) return;
    try {
      const raw = event.targetSessionFile;
      const file = resolve(raw.startsWith('file://') ? fileURLToPath(raw) : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw);
      const current = ctx.sessionManager.getSessionFile();
      if (current && canonicalPath(file) === canonicalPath(current)) return;
      const transfer = pending.get(pendingKey(file));
      if (transfer) return;
      const id = readId(file);
      const acquired = lease => {
        if (!alive || !lease) {
          lease?.release();
          return { cancel: true };
        }
        const value = savePending(file, id, lease);
        reopen = { file, value };
        blocked = 'Switching to the latest Session';
        // Re-enter through a command so later cancellation releases the lease.
        scheduleReopen();
        return { cancel: true };
      };
      try {
        const lease = reserve(stateDir, file, id);
        if (ctx.mode === 'tui' && id) return acquired(lease);
        lease.release();
      } catch (error) {
        if (ctx.mode !== 'tui' || !runtime.waitForBackground) throw error;
        const controller = new AbortController();
        waiting = controller;
        return runtime.waitForBackground(ctx, controller,
          signal => waitAndReserve(paths, file, id, error, signal)).then(acquired, failure => {
          if (alive && failure.name !== 'AbortError') notify(ctx, failure.message);
          return { cancel: true };
        }).finally(() => { if (waiting === controller) waiting = undefined; });
      }
    } catch (error) {
      notify(ctx, error.message);
      return { cancel: true };
    }
  });

  pi.on('session_shutdown', async (event, ctx) => {
    alive = false;
    waiting?.abort();
    if (runtime.stop) await runtime.stop(ctx);
    if (event.reason === 'reload') {
      // Cancel the old continuation and release its unclaimed target lease.
      if (reopen) discardPending(reopen.file, reopen.value);
      reopen = undefined;
      return;
    }
    // A background Worker keeps its lease until the process exits, after the last shutdown writes.
    if (event.reason === 'quit' && isBackgroundWorker(ctx)) return;
    if (event.reason === 'quit' && reopen) {
      discardPending(reopen.file, reopen.value);
      reopen = undefined;
    }
    leases.get(ctx.sessionManager)?.release();
    leases.delete(ctx.sessionManager);
  });
  pi.on('input', (_event, ctx) => {
    if (!blocked) return;
    notify(ctx, blocked);
    return { action: 'handled' };
  });
  pi.on('tool_call', () => blocked ? { block: true, reason: blocked, terminate: true } : undefined);
  pi.on('user_bash', () => blocked ? { result: { output: blocked, exitCode: 1, cancelled: true, truncated: false } } : undefined);
  for (const event of ['session_before_compact', 'session_before_tree', 'session_before_fork']) {
    pi.on(event, () => blocked ? { cancel: true } : undefined);
  }
}
