import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { acquireOwnership, reserve } from '../src/roots/ownership.mjs';
import { rootPaths } from '../src/roots/paths.mjs';
import { prepareDirectory, rememberedFiles } from '../src/roots/registry.mjs';
import { discoverRoots } from '../src/roots/discovery.mjs';
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
const stop = new AbortController();
const { parseSessionEntries, buildSessionContext } = await import(pathToFileURL(piIndex).href);
const router = createSupervisor({
  deliverToWorker: (message, options) => request(paths.worker(message.recipient), { action: 'deliver', message }, options),
  async wake(id, { signal }) {
    const combined = AbortSignal.any([signal, stop.signal]);
    const roots = await discoverRoots(sessionRoot, { extraFiles: await rememberedFiles(paths), signal: combined });
    const root = roots.find(entry => entry.id === id);
    if (!root) throw Object.assign(new Error(`No root Agent ${id}`), { code: 'UNKNOWN_AGENT' });
    const entries = parseSessionEntries(await readFile(root.sessionFile, { encoding: 'utf8', signal: combined }));
    const model = buildSessionContext(entries).model;
    reserve(paths.ownership, root.sessionFile, id).release();
    await launchWorker(root, {
      cli, extension, model, paths, signal: combined,
      onSpawn(child) {
        children.add(child);
        child.once('exit', () => children.delete(child));
        child.once('error', () => { if (!child.pid) children.delete(child); });
      },
    });
  },
});
await recoverSocket(paths.supervisor);
const server = await listenWorker(paths.supervisor, {
  serialize: false,
  status: () => ({ ready: true, pid: process.pid }),
  accept: (message, options) => router.accept(message, options),
});
let closing;
function shutdown() {
  if (closing) return;
  closing = true;
  stop.abort();
  void server.close().finally(async () => {
    await Promise.all([...children].map(child => stopWorker(child)));
    lease.release();
    process.exit(0);
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
