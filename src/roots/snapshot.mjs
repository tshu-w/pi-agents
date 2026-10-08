import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRoots } from './discovery.mjs';
import { isOccupied } from './ownership.mjs';
import { rememberedFiles } from './registry.mjs';
import { request } from './transport.mjs';

/**
 * Root Agents on disk with their state: `running` or `idle` when their runtime answers,
 * `running` when another runtime holds the Session without answering, `idle` otherwise.
 */
export async function rootSnapshot(paths, sessionRoot, { signal, current } = {}) {
  let sockets;
  try { sockets = (await readdir(paths.directory)).filter(name => /^w-[a-f0-9]{24}\.sock$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') sockets = []; else throw error; }
  const online = new Map();
  for (const socket of sockets) {
    signal?.throwIfAborted();
    try {
      const root = await request(join(paths.directory, socket), { action: 'status' }, { signal, timeoutMs: 1000 });
      if (root?.ready === true && typeof root.id === 'string' && typeof root.cwd === 'string' && typeof root.sessionFile === 'string'
        && ['idle', 'running'].includes(root.state) && paths.worker(root.id) === join(paths.directory, socket)) online.set(root.id, root);
    } catch (error) {
      signal?.throwIfAborted();
      if (!['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'CONNECTION_CLOSED', 'INVALID_FRAME'].includes(error.code)) throw error;
    }
  }
  if (current) online.set(current.id, current);
  // Online roots report their own metadata; skip reparsing their growing Session files.
  const skip = new Set([...online.values()].map(root => root.sessionFile));
  const records = await discoverRoots(sessionRoot, { extraFiles: await rememberedFiles(paths), skip, signal });
  const roots = [];
  for (const record of records) {
    signal?.throwIfAborted();
    if (online.has(record.id)) continue;
    try {
      record.state = isOccupied(paths.ownership, await realpath(record.sessionFile), record.id) ? 'running' : 'idle';
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    roots.push(record);
  }
  roots.push(...online.values());
  return roots;
}
