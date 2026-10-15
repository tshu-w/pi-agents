#!/usr/bin/env node
// The `pd` command: runs Pi in a host, attaching this terminal to interactive Pi and connecting
// non-interactive Pi to the hosted Session; `--no-session` and package commands run Pi directly.
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import { attach, hostSessionFile, settledHosts, startHost } from '../src/host/client.mjs';
import { detachKey, detachMatcher } from '../src/host/keys.mjs';
import { discoverRoots, findRoot } from '../src/roots/discovery.mjs';
import { defaultSessionDir, resolvePath, sessionDir, statePaths } from '../src/roots/paths.mjs';
import { piPackage } from '../src/pi.mjs';
import { markedFiles } from '../src/daemon/sessions.mjs';
import { argGroups } from '../src/host/rpc-client.mjs';

const real = process.env.PATH.split(':').map(dir => join(dir, 'pi')).find(file => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
});
if (!real) {
  process.stderr.write(`${error('pd needs Pi: install it so that pi is on PATH.')}\n`);
  process.exit(1);
}
const args = process.argv.slice(2);
const paths = statePaths();
const dist = file => import(pathToFileURL(join(piPackage(real), 'dist', file)).href);
// Pi's own parsing, so that `pd` reads every argument as `pi` does.
const { parseArgs } = await dist('cli/args.js');
const { ENV_SESSION_DIR, getAgentDir } = await dist('config.js');
const parsed = parseArgs(args);

const COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);

function runDirectly() {
  const child = spawn(real, args, { stdio: 'inherit' });
  // The terminal delivers Ctrl+C to Pi too; Pi decides what it means.
  process.on('SIGINT', () => {});
  child.on('exit', (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
    else process.exit(code ?? 1);
  });
}

function error(text) {
  return styleText('red', text, { stream: process.stderr });
}


/** Attaches the terminal to the host at `socket`; `send`, if given, sends messages once attached, and its error is reported once detached. */
async function attachAndReport(socket, send) {
  const tui = await import(pathToFileURL(createRequire(join(piPackage(real), 'package.json')).resolve('@earendil-works/pi-tui')).href);
  let sent;
  const result = await attach(socket, { isDetach: detachMatcher(tui, detachKey(getAgentDir())), onAttach: () => { sent = send?.(); } });
  const failure = await sent;
  if (failure) process.stderr.write(`${error(failure)}\n`);
  const id = result.session?.id;
  if (result.reason === 'exited') process.exit(failure ? 1 : result.exitCode ?? 0);
  if (result.reason === 'closed') {
    process.stderr.write(`${error(`The host stopped unexpectedly. See ${paths.hostLog}`)}\n`);
    process.exit(1);
  }
  if (result.reason === 'takeover') process.stdout.write('Attached in another terminal.\n');
  process.stdout.write(`${styleText('dim', 'Pi keeps running. To reattach:')} pd attach ${id ?? '<session>'}\n`);
  process.exit(failure ? 1 : 0);
}

/** The running host already holding the Session that `--session`, `--session-id`, or `-c` would open. */
async function runningTarget() {
  let running;
  const { session, sessionId } = parsed;
  if (session) {
    const file = resolve(session);
    running = host => host.session && (host.session.id.startsWith(session) || hostSessionFile(host) === file);
  } else if (sessionId && parsed.fork === undefined) {
    // With `--fork`, the ID names a new Session.
    const file = await sessionById(sessionId);
    // A Session without messages has no file yet; its host reports where it will be.
    const directory = await sessionDirOption() ?? defaultSessionDir(process.cwd(), getAgentDir());
    running = host => host.session && (file
      ? hostSessionFile(host) === file
      : host.session.id === sessionId && dirname(hostSessionFile(host)) === directory && host.session.cwd === process.cwd());
  } else if (parsed.continue) {
    const file = await recentSession();
    if (file) running = host => hostSessionFile(host) === file;
  }
  return running && (await settledHosts(paths, running)).find(running);
}

/** The Session `-c` continues, chosen by Pi's own `continueRecent` rules. */
async function recentSession() {
  const { findMostRecentSession } = await dist('core/session-manager.js');
  const configured = await sessionDirOption();
  const fallback = defaultSessionDir(process.cwd(), getAgentDir());
  const directory = configured ?? fallback;
  // A configured directory may hold other cwds' Sessions.
  return findMostRecentSession(directory, directory === fallback ? undefined : process.cwd()) ?? undefined;
}

/** The Session `--session-id` would open, found by Pi's own rules, if it exists. */
async function sessionById(id) {
  const { SessionManager } = await dist('core/session-manager.js');
  return SessionManager.findById(process.cwd(), id, await sessionDirOption());
}

/** The session directory configured for Pi in this cwd, as Pi resolves it: `--session-dir`, its environment variable, then its settings. */
async function sessionDirOption() {
  const configured = parsed.sessionDir || process.env[ENV_SESSION_DIR] || (await dist('core/settings-manager.js')).SettingsManager.create(process.cwd(), getAgentDir()).getSessionDir();
  return configured ? resolvePath(configured) : undefined;
}

async function attachCommand(query) {
  if (!query) {
    process.stderr.write(`${error('Usage: pd attach <session>')}\n`);
    process.exit(2);
  }
  const wanted = host => host.session && (host.session.id.startsWith(query) || host.session.name === query);
  const hosted = (await settledHosts(paths, wanted)).filter(wanted);
  if (hosted.length === 1) return attachAndReport(hosted[0].socket);
  let roots = [];
  if (!hosted.length) {
    const extraFiles = await markedFiles(paths);
    const exact = await findRoot(sessionDir(), query, { extraFiles });
    roots = exact ? [exact] : (await discoverRoots(sessionDir(), { extraFiles }))
      .filter(root => root.id.startsWith(query) || root.name === query);
  }
  const matches = hosted.length ? hosted.map(host => host.session) : roots;
  if (matches.length !== 1) {
    process.stderr.write(matches.length
      ? `${error(`"${query}" matches several Sessions:`)}\n${matches.map(match => `  ${match.id}  ${match.name ?? ''}`).join('\n')}\n`
      : `${error(`No Session matches "${query}".`)}\n`);
    process.exit(1);
  }
  const [root] = roots;
  const socket = await startHost(paths, {
    pi: real, args: ['--session', root.sessionFile], cwd: root.cwd,
    cols: process.stdout.columns, rows: process.stdout.rows, waitForTerminal: true,
  });
  return attachAndReport(socket);
}

/** Warns about the options a running Session does not apply. */
function warnIgnored(options) {
  const ignored = argGroups(parseArgs, options).filter(([option]) => !['--session', '--session-id', '--session-dir', '-c', '--continue'].includes(option)).flat();
  if (ignored.length) process.stderr.write(`${styleText('yellow', `The Session is already running; using it without applying: ${ignored.join(' ')}`, { stream: process.stderr })}\n`);
}

/** Pi's mode for `args` when it is not interactive: 'text', 'json', or 'rpc'. */
function headlessMode() {
  if (parsed.mode === 'json' || parsed.mode === 'rpc') return parsed.mode;
  if (!interactive || parsed.print) return 'text';
}

const interactive = process.stdin.isTTY && process.stdout.isTTY;
if (args[0] === 'attach' && interactive) await attachCommand(args[1]);
else if (args[0] === 'agents' && interactive) {
  const { workbench } = await import('../src/workbench.mjs');
  await workbench({ pi: real, paths, sessionDir: sessionDir() });
  process.exit(0);
}
else if (COMMANDS.has(args[0]) || parsed.help || parsed.version || parsed.export !== undefined || parsed.listModels !== undefined || parsed.noSession) {
  runDirectly();
}
else if (headlessMode()) {
  const { runHeadless } = await import('../src/host/rpc-client.mjs');
  await runHeadless({ pi: real, paths, args, mode: headlessMode(), findRunning: runningTarget, warnIgnored });
}
else {
  const running = await runningTarget();
  let send;
  if (running) {
    // Pi already runs this Session: its messages reach it as follow-ups once attached, as Pi sends them once its TUI starts,
    // and options that would start it differently do not apply.
    const { startupMessages } = await import('../src/host/rpc-client.mjs');
    send = await startupMessages({ pi: real, paths, args, running, warnIgnored });
  }
  const socket = running?.socket ?? await startHost(paths, {
    pi: real, args, cwd: process.cwd(), cols: process.stdout.columns, rows: process.stdout.rows, waitForTerminal: true,
  });
  await attachAndReport(socket, send);
}
