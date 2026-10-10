// The per-user daemon: tracks root Sessions, routes messages between them, and starts a host for
// a Session that is offline. Runs while a Session or the workbench is connected, exits once idle
// otherwise, and restarts once idle after pi-agents is updated.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { settledHosts, startHost } from '../src/host/client.mjs';
import { acquireLock, pruneLocks, reserve } from '../src/roots/locks.mjs';
import { prepareDirectory, statePaths } from '../src/roots/paths.mjs';
import { findRoot } from '../src/roots/discovery.mjs';
import { listen, request } from '../src/roots/transport.mjs';
import { recoverSocket } from '../src/roots/socket-recovery.mjs';
import { createSessions } from '../src/daemon/sessions.mjs';
import { createRouter } from '../src/daemon/router.mjs';
import { codeVersion } from '../src/daemon/version.mjs';

const [sessionDir] = process.argv.slice(2);
if (!sessionDir) throw new Error('Daemon requires the session directory');
const paths = statePaths();
await prepareDirectory(paths.runtime);
let lock;
try { lock = acquireLock({ stateDir: paths.locks, sessionId: 'daemon' }); }
catch (error) { if (error.code === 'SESSION_OCCUPIED') process.exit(0); throw error; }
pruneLocks(paths.locks);
const IDLE_MS = 30000;
const PUBLISH_MS = 250;
const RECHECK_MS = 1000;
const OCCUPIED_WAIT_MS = 5000;
const HOST_WAIT_MS = 3000;
const version = await codeVersion();
let waking = 0, delivering = 0, lastActivity = Date.now(), retiring = false, closing = false;
const stop = new AbortController();
const sessions = await createSessions(paths, sessionDir);
const workbenches = new Set();
const channels = new Map();

/** The model Pi restores for the Session: the last one set or used on its active branch, which ends at its last entry. */
async function savedModel(file, signal) {
  const entries = new Map();
  let leaf;
  for (const line of (await readFile(file, { encoding: 'utf8', signal })).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.id !== 'string' || entry.type === 'session') continue;
    entries.set(entry.id, entry);
    leaf = entry;
  }
  for (let entry = leaf; entry; entry = entries.get(entry.parentId)) {
    if (entry.type === 'model_change') return { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === 'message' && entry.message?.role === 'assistant') return { provider: entry.message.provider, modelId: entry.message.model };
  }
}

/** The status of the Session's Pi once it accepts messages, checking that it runs the Session expected. */
async function accepting(root, signal) {
  try {
    const status = await request(paths.session(root.id), { action: 'status' }, { signal, timeoutMs: 1000 });
    if (status.id !== root.id || status.cwd !== root.cwd) throw new Error('Awakened Agent identity or cwd does not match its Session');
    if (status.availabilityError) throw new Error(status.availabilityError);
    if (status.ready) return status;
  } catch (error) {
    signal.throwIfAborted();
    if (!['ENOENT', 'ECONNREFUSED', 'SOCKET_MODE'].includes(error.code)) throw error;
  }
}

/** Waits until the woken Session accepts messages with its saved model. */
async function ready(root, model, signal) {
  for (;;) {
    const status = await accepting(root, signal);
    if (status) {
      if (model && (status.model?.provider !== model.provider || status.model?.modelId !== model.modelId)) {
        throw new Error(`Saved model ${model.provider}/${model.modelId} was not restored; refusing model fallback.`);
      }
      return;
    }
    await delay(50, undefined, { signal });
  }
}

const router = createRouter({
  deliverToSession: (message, options) => request(paths.session(message.recipient), { action: 'deliver', message }, options),
  async wake(id, { signal, launch }) {
    if (!launch) throw Object.assign(new Error(`Agent ${id} is offline`), { code: 'OFFLINE' });
    waking++;
    try {
      const combined = AbortSignal.any([signal, stop.signal]);
      const root = await findRoot(sessionDir, id, { extraFiles: sessions.files(), signal: combined });
      if (!root) throw Object.assign(new Error(`No root Agent ${id}`), { code: 'UNKNOWN_AGENT' });
      if (typeof root.cwd !== 'string' || !root.cwd.trim() || !isAbsolute(root.cwd)) {
        throw Object.assign(new Error(`Agent ${id} requires a nonempty absolute working directory; refusing cwd fallback.`), { code: 'INVALID_CWD' });
      }
      // A host still starting Pi in the Session's cwd, as when a terminal has just opened the Session, may be
      // starting this Session. The wait leaves the rest of the wake time for starting the Session here.
      await settledHosts(paths, host => host.session?.id === id,
        { starting: host => !host.session && host.cwd === root.cwd, timeoutMs: HOST_WAIT_MS });
      // Another Pi may hold the Session briefly: one exiting releases it, one starting accepts the message once ready.
      for (const deadline = performance.now() + OCCUPIED_WAIT_MS; ;) {
        try { reserve(paths.locks, root.sessionFile, id).release(); break; }
        catch (error) { if (error.code !== 'SESSION_OCCUPIED' || performance.now() > deadline) throw error; }
        if (await accepting(root, combined)) return;
        await delay(100, undefined, { signal: combined });
      }
      // Pi restores a Session's model before extensions register their providers; name it explicitly.
      const model = await savedModel(root.sessionFile, combined);
      const args = [...launch.args, '--session', root.sessionFile, ...(model ? ['--model', `${model.provider}/${model.modelId}`] : [])];
      const socket = await startHost(paths, { pi: launch.command, args, cwd: root.cwd, env: launch.env });
      try { await ready(root, model, combined); }
      catch (error) {
        // A Session that cannot take the message does not stay running unseen.
        try { process.kill(Number(/h-(\d+)\.sock$/.exec(socket)[1]), 'SIGTERM'); } catch {}
        throw error;
      }
    } finally { waking--; lastActivity = Date.now(); }
  },
});

let publishing;
function changed() {
  if (publishing || !workbenches.size) return;
  publishing = delay(PUBLISH_MS).then(async () => {
    publishing = undefined;
    const list = await sessions.list();
    for (const workbench of workbenches) workbench.send({ type: 'sessions', sessions: list });
    // A Pi that reported its end holds the Session lock until it exits, which nothing else announces.
    if (list.some(row => row.status === 'unknown')) setTimeout(changed, RECHECK_MS).unref();
  }).catch(error => console.error(`[pi-agents] Listing Sessions failed: ${error.message}`));
}

const text = value => typeof value === 'string' ? value : undefined;
function sessionState(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return;
  const turn = value.turn && Number.isFinite(value.turn.at) ? { at: value.turn.at, failed: value.turn.failed === true } : undefined;
  return {
    id: value.id, sessionFile: text(value.sessionFile), cwd: text(value.cwd), name: text(value.name), title: text(value.title),
    host: text(value.host), attached: value.attached === true, working: value.working === true, blocked: value.blocked === true,
    tool: text(value.tool), reply: text(value.reply), agents: Number.isSafeInteger(value.agents) ? value.agents : 0,
    ...(turn ? { turn } : {}),
  };
}

function openSession(channel) {
  const reported = new Set();
  channel.onMessage(message => {
    if (message?.type === 'state') {
      const state = sessionState(message.state);
      if (!state) return;
      reported.add(state.id);
      channels.set(state.id, channel);
      sessions.update(state);
    } else if (message?.type === 'end' && typeof message.id === 'string' && reported.delete(message.id)) {
      if (channels.get(message.id) === channel) channels.delete(message.id);
      sessions.end(message.id);
    } else return;
    changed();
  });
  channel.signal.addEventListener('abort', () => {
    lastActivity = Date.now();
    if (closing) return;
    for (const id of reported) {
      if (channels.get(id) === channel) channels.delete(id);
      sessions.end(id, { abnormal: true });
    }
    changed();
  }, { once: true });
}

function openWorkbench(channel) {
  workbenches.add(channel);
  channel.onMessage(message => {
    if (typeof message?.id !== 'string') return;
    if (message.type === 'interrupt') channels.get(message.id)?.send({ type: 'interrupt', id: message.id });
    else if (message.type === 'show' || message.type === 'hide' || message.type === 'see') {
      sessions[message.type](message.id);
      changed();
    }
  });
  channel.signal.addEventListener('abort', () => { workbenches.delete(channel); lastActivity = Date.now(); }, { once: true });
  void sessions.list().then(list => channel.send({ type: 'sessions', sessions: list }),
    error => console.error(`[pi-agents] Listing Sessions failed: ${error.message}`));
}

await recoverSocket(paths.daemon);
const server = await listen(paths.daemon, {
  serialize: false,
  status: () => ({ ready: true, pid: process.pid, version }),
  async accept(message, options) {
    delivering++;
    try { return await router.accept(message, options); }
    finally { delivering--; }
  },
  stream(input, channel) {
    lastActivity = Date.now();
    // A newly started Pi may run updated code; this daemon then hands over once idle.
    void codeVersion().then(current => { if (current !== version) retiring = true; }, () => {});
    if (input.role === 'workbench') openWorkbench(channel);
    else openSession(channel);
  },
});

const idleTimer = setInterval(() => {
  if (closing || waking || delivering) return;
  if (retiring) return shutdown(server.close());
  if (Date.now() - lastActivity < IDLE_MS) return;
  const closed = server.closeIfIdle(IDLE_MS);
  if (closed) shutdown(closed);
}, 1000);

// Connected Sessions reconnect to the next daemon.
function shutdown(closed = server.close()) {
  if (closing) return;
  closing = true;
  clearInterval(idleTimer);
  stop.abort();
  void closed.finally(async () => {
    await sessions.saved();
    lock.release();
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());
