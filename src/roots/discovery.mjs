import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const cache = new Map();

export function isOwnedSession(entries) {
  return entries.some(entry => entry.type === 'custom' && entry.customType === 'pi-agents-tree'
    && typeof entry.data?.rootId === 'string');
}

// Read-only discovery must never open a SessionManager: opening can migrate or
// repair the very session another runtime is currently writing.
export async function readRootFile(sessionFile, { signal } = {}) {
  signal?.throwIfAborted();
  let metadata;
  try { metadata = await stat(sessionFile); }
  catch (error) { if (error.code === 'ENOENT') { cache.delete(sessionFile); return; } throw error; }
  const stamp = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
  const previous = cache.get(sessionFile);
  if (previous?.stamp === stamp) return previous.peer ? { ...previous.peer } : undefined;
  function remember(peer) {
    cache.set(sessionFile, { stamp, peer });
    return peer ? { ...peer } : undefined;
  }
  const input = createReadStream(sessionFile, { encoding: 'utf8', signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header, name, summary;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (!header) {
        if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id || typeof entry.cwd !== 'string') return remember();
        header = entry;
      }
      if (isOwnedSession([entry])) return remember();
      if (entry.type === 'session_info') name = typeof entry.name === 'string' ? entry.name : undefined;
      if (entry.type === 'compaction' && typeof entry.summary === 'string') summary = entry.summary;
    }
  } catch (error) {
    if (error.code === 'ENOENT') { cache.delete(sessionFile); return; }
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header) return remember();
  return remember({ id: header.id, name, cwd: header.cwd, summary, sessionFile, updatedAt: metadata.mtime.toISOString(), state: 'unknown' });
}

export async function discoverRoots(sessionRoot, { extraFiles = [], signal } = {}) {
  signal?.throwIfAborted();
  let directories;
  try { directories = await readdir(sessionRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') directories = []; else throw error; }
  const files = new Set(extraFiles);
  for (const directory of directories) {
    signal?.throwIfAborted();
    if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
    const path = join(sessionRoot, directory.name);
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    // Native roots are one level below sessions/. Child runtimes use nested
    // directories; parentSession alone cannot distinguish children from forks.
    for (const entry of entries) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) files.add(join(path, entry.name));
    }
  }
  const peers = [];
  for (const file of files) {
    const peer = await readRootFile(file, { signal });
    if (peer) peers.push(peer);
  }
  return peers;
}
