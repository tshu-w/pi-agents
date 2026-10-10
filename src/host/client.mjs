import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FRAME, frame, json, readFrames } from './frames.mjs';
import { prepareDirectory } from '../roots/paths.mjs';

const HOST = fileURLToPath(new URL('../../bin/host.mjs', import.meta.url));
const START_TIMEOUT_MS = 10000;
// Undo the terminal modes, progress, and program status Pi may have set, so the shell gets a plain terminal back.
const RESET = '\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2031l\x1b[?25h\x1b[0m\x1b]7501;state=clear\x1b\\\x1b]9;4;0\x07';
const ALT_SCREEN = /\x1b\[\?1049([hl])/g;
// Splits terminal input into key sequences: CSI and SS3 sequences, Alt+key, or a single character.
const KEYS = /\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b?[\s\S]/g;

function hostStatus(path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.setTimeout(1000, () => socket.destroy(Object.assign(new Error('Host status timed out'), { code: 'ETIMEDOUT' })));
    socket.on('error', reject);
    socket.on('close', () => reject(Object.assign(new Error('Host closed without a status'), { code: 'ECONNRESET' })));
    socket.on('connect', () => socket.write(frame(FRAME.status)));
    readFrames(socket, (type, body) => { if (type === FRAME.status) { resolve(json(body)); socket.destroy(); } });
  });
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Status of every running host; removes sockets left by hosts that died. */
export async function listHosts(paths) {
  let names;
  try { names = await readdir(paths.runtime); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const hosts = [];
  await Promise.all(names.map(async name => {
    const match = /^h-(\d+)\.sock$/.exec(name);
    if (!match) return;
    const path = join(paths.runtime, name);
    try { hosts.push({ ...await hostStatus(path), socket: path }); }
    catch (error) {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code) && !alive(Number(match[1]))) await unlink(path).catch(() => {});
    }
  }));
  return hosts;
}

/**
 * Running hosts once `found` matches one or no host `starting` remains, waiting at most `timeoutMs`:
 * a host whose Pi has not reported its Session yet may be starting the Session a caller looks for.
 */
export async function settledHosts(paths, found, { starting = host => !host.session, timeoutMs = START_TIMEOUT_MS } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const hosts = await listHosts(paths);
    if (hosts.some(found) || !hosts.some(starting) || performance.now() > deadline) return hosts;
    await delay(100);
  }
}

/**
 * Starts a detached host running `pi args` in `cwd` and resolves to its socket once it accepts connections.
 * With `waitForTerminal`, Pi starts when the first terminal attaches.
 */
export async function startHost(paths, { pi, args, cwd, cols = 120, rows = 40, env = process.env, waitForTerminal = false }) {
  // spawn reports a missing cwd as ENOENT, which callers would mistake for a missing socket.
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw Object.assign(new Error(`Working directory ${cwd} does not exist`), { code: 'INVALID_CWD' });
  }
  await prepareDirectory(paths.runtime);
  await prepareDirectory(paths.state);
  const logPath = paths.hostLog;
  const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let child, failure;
  try {
    child = spawn(process.execPath, [HOST], {
      cwd, detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...env, PI_AGENTS_HOST_CONFIG: JSON.stringify({ pi, args, cwd, cols, rows, waitForTerminal }) },
    });
    // A spawn error, such as a missing cwd, is emitted before the log closes.
    child.on('error', error => { failure = error; });
    child.once('exit', code => { failure ??= new Error(`Host exited (${code}). See ${logPath}`); });
  } finally { await log.close(); }
  child.unref();
  const socket = paths.host(child.pid);
  const deadline = performance.now() + START_TIMEOUT_MS;
  for (;;) {
    if (failure) throw failure;
    try { await hostStatus(socket); return socket; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    if (performance.now() > deadline) throw new Error(`Host did not start. See ${logPath}`);
    await delay(25);
  }
}

/**
 * Attaches this process's terminal to a host until the host detaches it or Pi exits.
 * The detach key detaches here, before Pi sees it, so it works whatever Pi shows.
 * Resolves to { reason: 'detach' | 'takeover' | 'exited' | 'closed', session }.
 */
export function attach(socketPath, { isDetach, stdin = process.stdin, stdout = process.stdout }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const size = () => ({ cols: stdout.columns, rows: stdout.rows });
    const onResize = () => socket.write(frame(FRAME.resize, size()));
    const onInput = data => {
      // The workbench's stdin is decoded as UTF-8; latin1 keeps a Buffer's bytes.
      const encoding = typeof data === 'string' ? 'utf8' : 'latin1';
      const keys = data.toString(encoding).match(KEYS) ?? [];
      const at = keys.findIndex(isDetach);
      if (at < 0) return socket.write(frame(FRAME.data, data));
      if (at > 0) socket.write(frame(FRAME.data, Buffer.from(keys.slice(0, at).join(''), encoding)));
      socket.write(frame(FRAME.detached));
    };
    let result, connected = false, altScreen = false;
    function finish() {
      stdout.off('resize', onResize);
      stdin.off('data', onInput);
      if (connected) {
        stdin.setRawMode(false);
        stdin.pause();
        // An exiting Pi restores the terminal itself.
        // Leaving the alternate screen returns the cursor to the line below the command; otherwise it ends a line.
        if (result?.reason !== 'exited') stdout.write(altScreen ? `\x1b[?1049l${RESET}` : `${RESET}\r\n`);
      }
      resolve(result ?? { reason: 'closed' });
    }
    socket.on('connect', () => {
      connected = true;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onInput);
      stdout.on('resize', onResize);
      socket.write(frame(FRAME.attach, size()));
    });
    readFrames(socket, (type, body) => {
      if (type === FRAME.data) {
        for (const [, mode] of body.toString('latin1').matchAll(ALT_SCREEN)) altScreen = mode === 'h';
        stdout.write(body);
      }
      else if (type === FRAME.detached) result = { ...json(body) };
      else if (type === FRAME.exited) result = { reason: 'exited', ...json(body) };
    });
    socket.on('error', error => { if (!connected) reject(error); });
    socket.on('close', finish);
  });
}
