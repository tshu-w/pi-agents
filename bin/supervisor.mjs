import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { acquireOwnership, reserve } from '../src/roots/ownership.mjs';
import { rootPaths } from '../src/roots/paths.mjs';
import { prepareDirectory, rememberedFiles } from '../src/roots/registry.mjs';
import { findRoot } from '../src/roots/discovery.mjs';
import { listenWorker, request } from '../src/roots/transport.mjs';
import { recoverSocket } from '../src/roots/socket-recovery.mjs';
import { createSupervisor } from '../src/roots/supervisor.mjs';
import { launchWorker, stopWorker } from '../src/roots/launch-worker.mjs';

// `extension` is the path Pi loaded pi-agents from, so a Worker whose settings also
// load it gets the same path, which Pi loads once.
const [cli, sessionRoot, piIndex, extension] = process.argv.slice(2);
if (!cli || !sessionRoot || !piIndex || !extension) throw new Error('Supervisor requires the Pi CLI path, session root, Pi package entry, and extension path');
const paths = rootPaths();
await prepareDirectory(paths.directory);
let lease;
try { lease = acquireOwnership({ stateDir: paths.ownership, sessionId: 'supervisor', sessionFile: paths.supervisor }); }
catch (error) { if (error.code === 'SESSION_OCCUPIED') process.exit(0); throw error; }
const children = new Set();
const IDLE_MS = 30000;
let waking = 0, lastWorkerActivity = Date.now();
const stop = new AbortController();
const { parseSessionEntries, buildSessionContext } = await import(pathToFileURL(piIndex).href);
const router = createSupervisor({
  deliverToWorker: (message, options) => request(paths.worker(message.recipient), { action: 'deliver', message }, options),
  async wake(id, { signal }) {
    waking++;
    try {
      const combined = AbortSignal.any([signal, stop.signal]);
      const root = await findRoot(sessionRoot, id, { extraFiles: await rememberedFiles(paths), signal: combined });
      if (!root) throw Object.assign(new Error(`No root Agent ${id}`), { code: 'UNKNOWN_AGENT' });
      const entries = parseSessionEntries(await readFile(root.sessionFile, { encoding: 'utf8', signal: combined }));
      const model = buildSessionContext(entries).model;
      reserve(paths.ownership, root.sessionFile, id).release();
      await launchWorker(root, {
        cli, extension, model, paths, signal: combined,
        onSpawn(child) {
          children.add(child);
          child.once('exit', () => { children.delete(child); lastWorkerActivity = Date.now(); });
          child.once('error', () => { if (!child.pid) { children.delete(child); lastWorkerActivity = Date.now(); } });
        },
      });
    } finally { waking--; lastWorkerActivity = Date.now(); }
  },
});
await recoverSocket(paths.supervisor);
const server = await listenWorker(paths.supervisor, {
  serialize: false,
  status: () => ({ ready: true, pid: process.pid }),
  accept: (message, options) => router.accept(message, options),
});
let closing;
const idleTimer = setInterval(() => shutdown(true), 1000);
function shutdown(idle = false) {
  if (closing) return;
  if (idle && (waking || children.size || Date.now() - lastWorkerActivity < IDLE_MS)) return;
  const closed = idle ? server.closeIfIdle(IDLE_MS) : server.close();
  if (!closed) return;
  closing = true;
  clearInterval(idleTimer);
  stop.abort();
  void closed.finally(async () => {
    await Promise.all([...children].map(child => stopWorker(child)));
    lease.release();
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
