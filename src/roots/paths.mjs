import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pi does not export its resolvePath; session paths only need ~ and file:// handling.
export function resolvePath(input) {
  const path = input.startsWith('file://') ? fileURLToPath(input) : input;
  return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}

/**
 * Kept data lives in the state directory; locks and sockets, which live only while their process
 * does, in `$XDG_RUNTIME_DIR` (macOS has none, so `runtime/` in the state directory).
 */
export function statePaths(env = process.env) {
  const state = env.PI_AGENTS_STATE_DIR
    ? resolve(env.PI_AGENTS_STATE_DIR)
    : join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'pi/agents');
  const runtime = !env.PI_AGENTS_STATE_DIR && env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'pi-agents') : join(state, 'runtime');
  return {
    state,
    runtime,
    workbench: join(state, 'workbench.json'),
    hostLog: join(state, 'host.log'),
    daemonLog: join(state, 'daemon.log'),
    host(pid) { return join(runtime, `h-${pid}.sock`); },
    locks: join(runtime, 'locks'),
    daemon: join(runtime, 'daemon.sock'),
    session(id) { return join(runtime, `s-${createHash('sha256').update(id).digest('hex').slice(0, 24)}.sock`); },
  };
}

/** Pi's agent directory: PI_CODING_AGENT_DIR, or ~/.pi/agent. */
export function agentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR ? resolvePath(env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi/agent');
}

/** The session directory configured without `--session-dir`: PI_CODING_AGENT_SESSION_DIR, then the global `sessionDir` setting. */
export function configuredSessionDir(env = process.env) {
  if (env.PI_CODING_AGENT_SESSION_DIR) return resolvePath(env.PI_CODING_AGENT_SESSION_DIR);
  let setting;
  try { setting = JSON.parse(readFileSync(join(agentDir(env), 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).sessionDir; }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (typeof setting === 'string' && setting) return resolvePath(setting);
}

/** Pi's session directory without `--session-dir`: the configured one, or `sessions/` in the agent directory. */
export function sessionDir(env = process.env) {
  return configuredSessionDir(env) ?? join(agentDir(env), 'sessions');
}

/** The directory Pi keeps a cwd's Sessions in when none is configured. */
export function defaultSessionDir(cwd, env = process.env) {
  return join(agentDir(env), 'sessions', `--${resolve(cwd).replace(/^\//, '').replace(/[/\\:]/g, '-')}--`);
}

export async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error(`Agent runtime directory must be private and owned by the current user: ${directory}`);
  }
}
