import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { flockSync } from 'fs-ext';

/** The Session ID of a lock key: `id:<id>`, or `path:<file>` whose name ends with `_<id>.jsonl`. */
function sessionLabel(key) {
  const name = key.replace(/^admission:/, '');
  if (name.startsWith('id:')) return name.slice(3);
  return basename(name.slice(5), '.jsonl').split('_').pop();
}

export class SessionOccupiedError extends Error {
  constructor(sessionId, owner) {
    const label = sessionLabel(sessionId);
    super(owner?.background
      ? `[pi-agents] Session ${label} is in use by a background Worker (PID ${owner.pid}). Use /resume to wait.`
      : `[pi-agents] Session ${label} is in use${owner ? ` (PID ${owner.pid})` : ''}. Exit the other Pi instance.`);
    this.name = 'SessionOccupiedError';
    this.code = 'SESSION_OCCUPIED';
    this.sessionId = sessionId;
    this.owner = owner;
  }
}

function readOwner(fd, sessionId) {
  const size = fstatSync(fd).size;
  if (size === 0 || size > 8192) return;
  const buffer = Buffer.alloc(size);
  const bytes = readSync(fd, buffer, 0, size, 0);
  // A contender may observe metadata while its owner is writing it.
  let owner;
  try { owner = JSON.parse(buffer.subarray(0, bytes).toString()); }
  catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  if (owner?.sessionId === sessionId && Number.isSafeInteger(owner.pid) && typeof owner.sessionFile === 'string') return owner;
}

function acquireLock({ stateDir, sessionId, sessionFile, background = false }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Session ID is required');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(stateDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) {
    throw new Error(`Ownership directory must be a private directory owned by the current user: ${stateDir}`);
  }
  const key = createHash('sha256').update(sessionId).digest('hex');
  const fd = openSync(join(stateDir, `${key}.lock`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) {
      throw new Error('Ownership lock must be a private regular file owned by the current user');
    }
    try { flockSync(fd, 'exnb'); }
    catch (error) {
      if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error;
      throw new SessionOccupiedError(sessionId, readOwner(fd, sessionId));
    }
    const owner = { sessionId, pid: process.pid, sessionFile: resolve(sessionFile), acquiredAt: new Date().toISOString(), background };
    const data = Buffer.from(JSON.stringify(owner));
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, offset);
    ftruncateSync(fd, data.length);
    // Keep the inode on release: unlinking a lock file can admit two owners.
    return { owner, release() { closeSync(fd); } };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// flock conflicts between descriptors of one process, so the extension, the
// guard and a /resume wait share each lock through one reference-counted table.
const locks = globalThis[Symbol.for('pi-agents.ownership-locks')] ??= new Map();

export function acquireOwnership(options) {
  const key = `${resolve(options.stateDir)}\n${options.sessionId}`;
  let lock = locks.get(key);
  if (!lock) {
    lock = { lease: acquireLock(options), refs: 0 };
    locks.set(key, lock);
  }
  lock.refs++;
  let released = false;
  return {
    owner: lock.lease.owner,
    release() {
      if (released) return;
      released = true;
      if (--lock.refs > 0) return;
      locks.delete(key);
      lock.lease.release();
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

export function reserveKeys(stateDir, sessionFile, keys, background = false) {
  const held = [];
  try {
    for (const sessionId of keys) held.push(acquireOwnership({ stateDir, sessionFile, sessionId, background }));
  } catch (error) {
    for (const lease of held) lease.release();
    throw error;
  }
  return { release() { for (const lease of held) lease.release(); } };
}

// Admission locks fence new owners while a /resume waits for a background Worker.
export function reserve(stateDir, sessionFile, id, background = false) {
  const keys = lockKeys(sessionFile, id);
  const admission = reserveKeys(stateDir, sessionFile, keys.map(key => `admission:${key}`));
  try { return reserveKeys(stateDir, sessionFile, keys, background); }
  finally { admission.release(); }
}
