import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRoots } from './discovery.mjs';
import { reserve } from './ownership.mjs';
import { rememberedFiles } from './registry.mjs';
import { request } from './transport.mjs';

/**
 * Root Agents on disk with their state: `busy` or `idle` when their runtime answers,
 * `busy` when another runtime holds the Session without answering, `offline` otherwise.
 */
export async function rootSnapshot(paths, sessionRoot, { signal, current } = {}) {
  const extraFiles = await rememberedFiles(paths);
  if (current?.sessionFile) extraFiles.push(current.sessionFile);
  const records = await discoverRoots(sessionRoot, { extraFiles, signal });
  let sockets;
  try { sockets = (await readdir(paths.directory)).filter(name => /^w-[a-f0-9]{24}\.sock$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') sockets = []; else throw error; }
  const online = new Map();
  for (const socket of sockets) {
    signal?.throwIfAborted();
    try {
      const root = await request(join(paths.directory, socket), { action: 'status' }, { signal, timeoutMs: 1000 });
      if (root?.ready === true && typeof root.id === 'string' && typeof root.cwd === 'string' && typeof root.sessionFile === 'string'
        && ['idle', 'busy'].includes(root.state) && paths.worker(root.id) === join(paths.directory, socket)) online.set(root.id, root);
    } catch (error) {
      signal?.throwIfAborted();
      if (!['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'CONNECTION_CLOSED', 'INVALID_FRAME'].includes(error.code)) throw error;
    }
  }
  if (current) online.set(current.id, current);
  const roots = [];
  for (const record of records) {
    signal?.throwIfAborted();
    if (online.has(record.id)) continue;
    try {
      reserve(paths.ownership, await realpath(record.sessionFile), record.id).release();
      record.state = 'offline';
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code !== 'SESSION_OCCUPIED') throw error;
      record.state = 'busy';
    }
    roots.push(record);
  }
  for (const root of online.values()) {
    const record = records.find(entry => entry.id === root.id);
    roots.push({ ...record, ...root });
  }
  return roots;
}
