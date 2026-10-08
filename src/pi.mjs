// pd and the workbench run outside Pi, so they load Pi's modules from the package of the `pi` they run.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PACKAGE = '@earendil-works/pi-coding-agent';

/** Pi's package directory, found from its executable: an npm bin link or a Homebrew wrapper. */
export function piPackage(executable) {
  for (let dir = dirname(realpathSync(executable)); ; dir = dirname(dir)) {
    for (const candidate of [dir, join(dir, 'lib/node_modules', PACKAGE), join(dir, 'libexec/lib/node_modules', PACKAGE)]) {
      try { if (JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).name === PACKAGE) return candidate; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    if (dirname(dir) === dir) throw new Error(`Cannot find ${PACKAGE} from ${executable}`);
  }
}
