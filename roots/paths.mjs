import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function rootPaths(env = process.env) {
  const base = env.PI_AGENTS_STATE_DIR
    ? resolve(env.PI_AGENTS_STATE_DIR)
    : join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'pi/agents');
  const directory = join(base, 'runtime');
  return {
    directory,
    ownership: join(base, 'ownership'),
    supervisor: join(directory, 'supervisor.sock'),
    worker(id) { return join(directory, `w-${createHash('sha256').update(id).digest('hex').slice(0, 24)}.sock`); },
  };
}
