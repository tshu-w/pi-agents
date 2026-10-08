import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A hash of the package's code on disk, which changes when pi-agents is updated. */
export async function codeVersion() {
  const hash = createHash('sha256');
  const files = ['package.json'];
  for (const directory of ['bin', 'src']) {
    for (const entry of await readdir(join(ROOT, directory), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.push(join(entry.parentPath.slice(ROOT.length), entry.name));
    }
  }
  for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(join(ROOT, file))).update('\0');
  return hash.digest('hex').slice(0, 16);
}
