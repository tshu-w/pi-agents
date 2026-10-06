import { canonicalPath, lockKeys, reserve, reserveKeys } from './ownership.mjs';
import { rootPaths } from './paths.mjs';
import { getBackgroundWorkerStatus, isBackgroundWorker, waitForWorkerExit } from './background.mjs';
import { readSessionId, resolvePath } from './guard.mjs';

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

const switchers = globalThis[Symbol.for('pi-agents.switch-session')] ??= { byManager: new WeakMap(), patched: false };

/**
 * Pi gives `switchSession` only to command handlers. Keep the one it binds to each runner, by
 * Session manager, so a handover can switch without a command. Relies on a private member of
 * `ExtensionRunner`; check it when Pi is updated.
 */
function captureSwitchSession(Runner) {
  if (switchers.patched) return;
  switchers.patched = true;
  const bind = Runner.prototype.bindCommandContext;
  Runner.prototype.bindCommandContext = function (actions) {
    if (actions?.switchSession) switchers.byManager.set(this.sessionManager, actions.switchSession);
    return bind.call(this, actions);
  };
}

/**
 * Holds the current Session's ownership so one runtime uses a Session at a time.
 * An occupied Session is quarantined; /resume waits for a background Worker to exit.
 */
export default function ownershipExtension(pi, runtime = {}) {
  if (runtime.runner) captureSwitchSession(runtime.runner);
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

  function scheduleReopen(ctx) {
    // Session replacement must run after the current hooks.
    setTimeout(async () => {
      if (!alive || !reopen) return;
      const { file, value } = reopen;
      reopen = undefined;
      replacing = true;
      try {
        const switchSession = switchers.byManager.get(ctx.sessionManager);
        if (!switchSession) throw new Error('Session handover is unavailable; reopen the Session with /resume.');
        const result = await switchSession(file);
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
      if (ctx.mode === 'tui' && error.code === 'SESSION_OCCUPIED') {
        await ctx.ui.select(blocked, ['Exit Pi']);
      } else notify(ctx, blocked);
      // A thrown session_start error is swallowed by Pi. Explicitly quarantine
      // normal input/tool execution while the host performs graceful shutdown.
      ctx.shutdown();
    }
  });

  pi.on('session_before_switch', (event, ctx) => {
    if (blocked && !replacing) return { cancel: true };
    if (event.reason !== 'resume' || !event.targetSessionFile) return;
    try {
      const file = resolvePath(event.targetSessionFile);
      const current = ctx.sessionManager.getSessionFile();
      if (current && canonicalPath(file) === canonicalPath(current)) return;
      const transfer = pending.get(pendingKey(file));
      if (transfer) return;
      const id = readSessionId(file);
      const acquired = lease => {
        if (!alive || !lease) {
          lease?.release();
          return { cancel: true };
        }
        const value = savePending(file, id, lease);
        reopen = { file, value };
        blocked = 'Switching to the latest Session';
        // Switch again later so a cancellation releases the lease.
        scheduleReopen(ctx);
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
