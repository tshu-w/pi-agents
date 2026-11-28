// pd and the workbench run outside Pi, so they load Pi's modules from the package of the `pi` they run.
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

const PACKAGE = '@earendil-works/pi-coding-agent';

/** Keep a matching PATH entry unresolved so an installation upgrade can retarget it. */
export function executableOnPath(name, current, env = process.env) {
  const identity = name === 'pi' ? piPackage : realpathSync;
  const missing = !existsSync(current);
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      // A directory passes X_OK too.
      if (!statSync(candidate).isFile()) continue;
      if (missing || identity(candidate) === identity(current)) return candidate;
    } catch {}
  }
  return current;
}

/** PATH's Pi may be a wrapper, so run it directly rather than passing it to Node. */
export function piLaunch(cli, args, env = process.env) {
  const command = executableOnPath('pi', cli, env);
  if (command !== cli && (!existsSync(cli) || realpathSync(command) !== realpathSync(cli))) return { command, args };
  return { command: executableOnPath('node', process.execPath, env), args: [command, ...args] };
}

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
