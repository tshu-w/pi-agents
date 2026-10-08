import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The Session ID of a lock key: `id:<id>`, or `path:<file>` whose name ends with `_<id>.jsonl`. */
function sessionLabel(key) {
  if (key.startsWith('id:')) return key.slice(3);
  return basename(key.slice(5), '.jsonl').split('_').pop();
}

export class SessionOccupiedError extends Error {
  constructor(sessionId, owner) {
    const label = sessionLabel(sessionId);
    super(`[pi-agents] Session ${label} is in use${owner ? ` (PID ${owner.pid})` : ''}. Quit the other Pi instance.`);
    this.name = 'SessionOccupiedError';
    this.code = 'SESSION_OCCUPIED';
    this.sessionId = sessionId;
    this.owner = owner;
  }
}

// Each contender for a lock creates its own file, `<key hash>.<pid>-<start>.lock`, and holds the
// lock if no other live process has such a file. Only its creator or a pruner of a dead process
// removes a file, so a holder's file never disappears under it.
const RETRIES = 3;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

/** When the process started, as ps reports it, or NaN without ps. */
function startOf(pid) {
  const ps = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return ps.status === 0 ? Date.parse(ps.stdout.trim()) : NaN;
}

// The process's own start comes from ps too, since a wrapper may have exec'd Node long after the PID began.
// Without ps it is unknown (0), and others then trust the PID alone.
let selfStart;
const ownStart = () => selfStart ??= startOf(process.pid) || 0;

/** Whether a lock's holder still runs. A process that reused its PID started later; without a known start, the PID is trusted. */
function alive(owner) {
  if (owner.pid === process.pid) return owner.start === ownStart();
  if (!pidAlive(owner.pid)) return false;
  if (owner.start === 0) return true;
  const started = startOf(owner.pid);
  return Number.isNaN(started) || Math.abs(owner.start - started) < 3000;
}

const keyHash = sessionId => createHash('sha256').update(sessionId).digest('hex');

/** The lock files in `stateDir`, optionally only those of one key, with their holders. */
function lockFiles(stateDir, hash) {
  let names;
  try { names = readdirSync(stateDir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.flatMap(name => {
    const match = /^([0-9a-f]{64})\.(\d+)-(\d+)\.lock$/.exec(name);
    if (!match || (hash && match[1] !== hash)) return [];
    return [{ path: join(stateDir, name), owner: { pid: Number(match[2]), start: Number(match[3]) } }];
  });
}

function removeFile(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

function createLock({ stateDir, sessionId }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Session ID is required');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(stateDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) {
    throw new Error(`Lock directory must be a private directory owned by the current user: ${stateDir}`);
  }
  const hash = keyHash(sessionId);
  const owner = { pid: process.pid, start: ownStart() };
  const path = join(stateDir, `${hash}.${owner.pid}-${owner.start}.lock`);
  for (let attempt = 0; ; attempt++) {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    let other;
    for (const lock of lockFiles(stateDir, hash)) {
      if (lock.path === path) continue;
      if (alive(lock.owner)) other ??= lock;
      else removeFile(lock.path);
    }
    if (!other) return { owner, release() { removeFile(path); } };
    removeFile(path);
    // Contenders that see each other both back off; a short random pause lets one of them win.
    if (attempt === RETRIES) throw new SessionOccupiedError(sessionId, other.owner);
    Atomics.wait(pause, 0, 0, 5 + Math.random() * 20);
  }
}

/** Removes the lock files of processes that ended without releasing them. */
export function pruneLocks(stateDir) {
  for (const lock of lockFiles(stateDir)) if (!alive(lock.owner)) removeFile(lock.path);
}

// A process's own lock reads as held, so the extension, the guard and a
// /resume wait share each lock through one reference-counted table.
const locks = globalThis[Symbol.for('pi-agents.locks')] ??= new Map();

const tableKey = (stateDir, sessionId) => `${resolve(stateDir)}\n${sessionId}`;

export function acquireLock(options) {
  const key = tableKey(options.stateDir, options.sessionId);
  let entry = locks.get(key);
  if (!entry) {
    entry = { lock: createLock(options), refs: 0 };
    locks.set(key, entry);
  }
  entry.refs++;
  let released = false;
  return {
    owner: entry.lock.owner,
    release() {
      if (released) return;
      released = true;
      if (--entry.refs > 0) return;
      locks.delete(key);
      entry.lock.release();
    },
  };
}

export function canonicalPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

export function lockKeys(sessionFile, id) {
  return [`path:${canonicalPath(sessionFile)}`, ...(id ? [`id:${id}`] : [])];
}

function reserveKeys(stateDir, keys) {
  const held = [];
  try {
    for (const sessionId of keys) held.push(acquireLock({ stateDir, sessionId }));
  } catch (error) {
    for (const lock of held) lock.release();
    throw error;
  }
  return { release() { for (const lock of held) lock.release(); } };
}

// This process may acquire its own locks again, so only another process can hold them.
function heldElsewhere(stateDir, sessionId) {
  if (locks.has(tableKey(stateDir, sessionId))) return false;
  return lockFiles(stateDir, keyHash(sessionId)).some(lock => alive(lock.owner));
}

/** Whether `reserve` would find the Session occupied, without creating or acquiring its locks. */
export function isLocked(stateDir, sessionFile, id) {
  return lockKeys(sessionFile, id).some(key => heldElsewhere(stateDir, key));
}

export function reserve(stateDir, sessionFile, id) {
  return reserveKeys(stateDir, lockKeys(sessionFile, id));
}
