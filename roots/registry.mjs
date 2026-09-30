import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error(`Agent runtime directory must be private and owned by the current user: ${directory}`);
  }
}

export async function rememberRoot(paths, peer) {
  await prepareDirectory(paths.directory);
  const path = paths.worker(peer.id).replace(/\.sock$/, '.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await file.writeFile(JSON.stringify({ id: peer.id, sessionFile: peer.sessionFile })); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export async function rememberedFiles(paths) {
  let entries;
  try { entries = await readdir(paths.directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const name of entries) {
    if (!/^w-[a-f0-9]{24}\.json$/.test(name)) continue;
    const file = await open(join(paths.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid() || info.size > 16384 || (info.mode & 0o077)) continue;
      let record;
      try { record = JSON.parse(await file.readFile('utf8')); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (typeof record?.id === 'string' && typeof record.sessionFile === 'string'
        && paths.worker(record.id).replace(/\.sock$/, '.json') === join(paths.directory, name)) files.push(record.sessionFile);
    } finally { await file.close(); }
  }
  return files;
}
