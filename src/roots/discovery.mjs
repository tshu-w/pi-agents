import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const cache = new Map();

/** The first line of a message's text, for the workbench row. */
function firstLine(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
  const line = text.trim().split('\n')[0];
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

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
  if (previous?.stamp === stamp) return previous.root ? { ...previous.root } : undefined;
  function remember(root) {
    cache.set(sessionFile, { stamp, root });
    return root ? { ...root } : undefined;
  }
  const input = createReadStream(sessionFile, { encoding: 'utf8', signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header, name, summary, title, reply;
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
      if (entry.type === 'message' && entry.message?.role === 'user') title ??= firstLine(entry.message.content);
      if (entry.type === 'message' && entry.message?.role === 'assistant') reply = firstLine(entry.message.content) || firstLine(entry.message.errorMessage) || reply;
    }
  } catch (error) {
    if (error.code === 'ENOENT') { cache.delete(sessionFile); return; }
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header) return remember();
  return remember({ id: header.id, name, title: title || undefined, reply, cwd: header.cwd, summary, sessionFile, updatedAt: metadata.mtime.toISOString(), state: 'unknown' });
}

async function sessionFiles(sessionDir, extraFiles, signal) {
  signal?.throwIfAborted();
  let directories;
  try { directories = await readdir(sessionDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') directories = []; else throw error; }
  const files = new Set(extraFiles);
  for (const directory of directories) {
    signal?.throwIfAborted();
    // A configured sessionDir holds roots directly, and child runtimes in subagents/.
    if (directory.isFile() && directory.name.endsWith('.jsonl')) files.add(join(sessionDir, directory.name));
    if ((!directory.isDirectory() && !directory.isSymbolicLink()) || directory.name === 'subagents') continue;
    const path = join(sessionDir, directory.name);
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    // Pi's default layout keeps roots one level below sessions/. Child runtimes use nested
    // directories; parentSession alone cannot distinguish children from forks.
    for (const entry of entries) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) files.add(join(path, entry.name));
    }
  }
  return files;
}

/**
 * Root Sessions in `sessionDir` and `extraFiles`; with `ids`, only those. A file Pi named
 * `<timestamp>_<id>.jsonl` is skipped by its name; others are read for their ID.
 */
export async function discoverRoots(sessionDir, { extraFiles = [], ids, skip, signal } = {}) {
  const roots = [];
  for (const file of await sessionFiles(sessionDir, extraFiles, signal)) {
    const named = /_([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1];
    if (skip?.has(file) || (ids && named && !ids.has(named))) continue;
    const root = await readRootFile(file, { signal });
    if (root && (!ids || ids.has(root.id))) roots.push(root);
  }
  return roots;
}

// Pi names Session files `<timestamp>_<id>.jsonl`; read those first and scan every
// Session only when no such file is the root.
export async function findRoot(sessionDir, id, { extraFiles = [], signal } = {}) {
  for (const file of await sessionFiles(sessionDir, extraFiles, signal)) {
    if (!file.endsWith(`_${id}.jsonl`)) continue;
    const root = await readRootFile(file, { signal });
    if (root?.id === id) return root;
  }
  return (await discoverRoots(sessionDir, { extraFiles, signal })).find(entry => entry.id === id);
}
