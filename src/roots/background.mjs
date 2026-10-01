import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from './transport.mjs';

// Captured once per process: the Supervisor launches a background Worker for one Session.
const key = Symbol.for('pi-agents.background-identity');
if (!Object.hasOwn(globalThis, key)) {
  globalThis[key] = process.env.PI_AGENTS_BACKGROUND === '1'
    && process.env.PI_AGENTS_BACKGROUND_PARENT === String(process.ppid)
    ? { pid: process.pid, sessionId: process.env.PI_AGENTS_EXPECTED_SESSION } : undefined;
}

export function isBackgroundWorker(ctx) {
  const background = globalThis[key];
  return ctx.mode === 'rpc' && background?.pid === process.pid
    && background.sessionId === ctx.sessionManager.getSessionId();
}

export async function getBackgroundWorkerStatus(socket, { sessionId, sessionFile, ownerPid, signal, timeoutMs = 1000 }) {
  const status = await request(socket, { action: 'status' }, { signal, timeoutMs });
  if (status?.background !== true || status.pid !== ownerPid || status.id !== sessionId
    || typeof status.sessionFile !== 'string' || realpathSync(status.sessionFile) !== realpathSync(sessionFile)) {
    throw Object.assign(new Error('Session is not owned by the expected background Worker; close its current runtime before reopening it.'), { code: 'SESSION_OCCUPIED' });
  }
  return status;
}

// Cancellation only stops this wait; it never interrupts the Worker's accepted work.
export async function waitForWorkerExit(ownerPid, { signal } = {}) {
  for (;;) {
    signal?.throwIfAborted();
    try { process.kill(ownerPid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(25, undefined, { signal });
  }
}
