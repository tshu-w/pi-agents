import { canonicalPath, reserve } from './locks.mjs';
import { resolvePath, statePaths } from './paths.mjs';
import { readSessionId } from './guard.mjs';

// Pi reloads extension modules but keeps the SessionManager. Retain its lock
// across reload without allowing a different manager to borrow it.
const locks = globalThis[Symbol.for('pi-agents.extension-locks')] ??= new WeakMap();
const pending = globalThis[Symbol.for('pi-agents.pending-locks')] ??= new Map();

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
 * Holds the current Session's lock so one runtime uses a Session at a time.
 * An occupied Session is quarantined.
 */
export default function lockExtension(pi, runtime = {}) {
  if (runtime.runner) captureSwitchSession(runtime.runner);
  const paths = statePaths();
  const stateDir = paths.locks;
  let blocked = 'Session lock has not been acquired';
  let reopen;
  let replacing = false;
  let alive = true;
  const pendingKey = file => `${stateDir}\n${canonicalPath(file)}`;
  function savePending(file, id, lock) {
    const key = pendingKey(file);
    const value = { id, lock };
    pending.set(key, value);
    return value;
  }
  function discardPending(file, value) {
    if (pending.get(pendingKey(file)) !== value) return;
    pending.delete(pendingKey(file));
    value.lock.release();
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
      if (file && !locks.has(manager)) {
        const transfer = pending.get(pendingKey(file));
        if (event.reason === 'resume' && transfer?.id === manager.getSessionId()) {
          pending.delete(pendingKey(file));
          locks.set(manager, transfer.lock);
        } else {
          // Target loading has already happened. A takeover here would leave
          // stale shutdown writers attached to the same Session file.
          locks.set(manager, reserve(stateDir, file, manager.getSessionId()));
        }
      }
      if (runtime.start) await runtime.start(ctx);
      blocked = undefined;
    } catch (error) {
      blocked = error.message;
      if (ctx.mode === 'tui' && error.code === 'SESSION_OCCUPIED') {
        await ctx.ui.select(blocked, ['Quit']);
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
      const acquired = lock => {
        if (!alive || !lock) {
          lock?.release();
          return { cancel: true };
        }
        const value = savePending(file, id, lock);
        reopen = { file, value };
        blocked = 'Switching to the latest Session';
        // Switch again later so a cancellation releases the lock.
        scheduleReopen(ctx);
        return { cancel: true };
      };
      const lock = reserve(stateDir, file, id);
      if (ctx.mode === 'tui' && id) return acquired(lock);
      lock.release();
    } catch (error) {
      notify(ctx, error.message);
      return { cancel: true };
    }
  });

  pi.on('session_shutdown', async (event, ctx) => {
    alive = false;
    if (runtime.stop) await runtime.stop(ctx);
    if (event.reason === 'reload') {
      // Cancel the old continuation and release its unclaimed target lock.
      if (reopen) discardPending(reopen.file, reopen.value);
      reopen = undefined;
      return;
    }
    if (event.reason === 'quit' && reopen) {
      discardPending(reopen.file, reopen.value);
      reopen = undefined;
    }
    locks.get(ctx.sessionManager)?.release();
    locks.delete(ctx.sessionManager);
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
