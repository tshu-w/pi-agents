import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const execFileAsync = promisify(execFile);

/** The package's git commit, or its version outside a git checkout, which changes when pi-agents is updated. */
export async function codeVersion() {
  if (existsSync(join(ROOT, '.git'))) return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim();
  return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
}
