#!/usr/bin/env node
// The `pd` command: runs interactive Pi in a host and attaches this terminal; everything else
// runs Pi directly.
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attach, listHosts, startHost } from '../src/host/client.mjs';
import { detachKey, detachMatcher } from '../src/host/keys.mjs';
import { discoverRoots, findRoot } from '../src/roots/discovery.mjs';
import { agentDir, configuredSessionDir, defaultSessionDir, resolvePath, sessionDir, statePaths } from '../src/roots/paths.mjs';
import { piPackage } from '../src/pi.mjs';
import { markedFiles } from '../src/daemon/sessions.mjs';

const real = process.env.PATH.split(':').map(dir => join(dir, 'pi')).find(file => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
});
if (!real) {
  process.stderr.write('pd needs Pi: install it so that pi is on PATH.\n');
  process.exit(1);
}
const args = process.argv.slice(2);
const paths = statePaths();

const COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);
const DIRECT_FLAGS = new Set(['-p', '--print', '--mode', '-h', '--help', '-v', '--version', '--export', '--list-models', '--no-session']);

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

function option(name, alias) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return;
    if (args[i] === name || args[i] === alias) return args[i + 1] ?? '';
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
}


async function attachAndReport(socket) {
  const tui = await import(pathToFileURL(createRequire(join(piPackage(real), 'package.json')).resolve('@earendil-works/pi-tui')).href);
  const result = await attach(socket, { isDetach: detachMatcher(tui, detachKey(agentDir())) });
  const id = result.session?.id;
  if (result.reason === 'exited') process.exit(result.exitCode ?? 0);
  if (result.reason === 'closed') {
    process.stderr.write(`The host stopped unexpectedly. See ${paths.hostLog}\n`);
    process.exit(1);
  }
  if (result.reason === 'takeover') process.stdout.write('Attached in another terminal.\n');
  process.stdout.write(`Pi keeps running. To reattach, run pd attach ${id ?? '<session>'}\n`);
  process.exit(0);
}

/** The running host already holding the Session that `--session` or `-c` would open. */
async function runningTarget(hosts) {
  const session = option('--session');
  if (session) {
    const file = resolve(session);
    return hosts.find(host => host.session && (host.session.id.startsWith(session) || host.session.file === file));
  }
  if (args.includes('-c') || args.includes('--continue')) {
    const file = await recentSession();
    return file && hosts.find(host => host.session?.file === file);
  }
}

/** The Session `-c` continues, chosen by Pi's own `continueRecent` rules. */
async function recentSession() {
  const { findMostRecentSession } = await import(pathToFileURL(join(piPackage(real), 'dist/core/session-manager.js')).href);
  const flag = option('--session-dir');
  const configured = flag ? resolvePath(flag) : configuredSessionDir();
  const fallback = defaultSessionDir(process.cwd());
  const directory = configured ?? fallback;
  // A configured directory may hold other cwds' Sessions.
  return findMostRecentSession(directory, directory === fallback ? undefined : process.cwd()) ?? undefined;
}

async function attachCommand(query) {
  if (!query) {
    process.stderr.write('Usage: pd attach <session>\n');
    process.exit(2);
  }
  const hosts = await listHosts(paths);
  const hosted = hosts.filter(host => host.session && (host.session.id.startsWith(query) || host.session.name === query));
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
      ? `"${query}" matches several Sessions:\n${matches.map(match => `  ${match.id}  ${match.name ?? ''}`).join('\n')}\n`
      : `No Session matches "${query}".\n`);
    process.exit(1);
  }
  const [root] = roots;
  const socket = await startHost(paths, {
    pi: real, args: ['--session', root.sessionFile], cwd: root.cwd,
    cols: process.stdout.columns, rows: process.stdout.rows, waitForTerminal: true,
  });
  return attachAndReport(socket);
}

const interactive = process.stdin.isTTY && process.stdout.isTTY;
if (args[0] === 'attach' && interactive) await attachCommand(args[1]);
else if (args[0] === 'agents' && interactive) {
  const { workbench } = await import('../src/workbench.mjs');
  await workbench({ pi: real, paths, sessionDir: sessionDir() });
  process.exit(0);
}
else if (!interactive || COMMANDS.has(args[0]) || args.some(arg => DIRECT_FLAGS.has(arg.split('=')[0]))) runDirectly();
else {
  const running = await runningTarget(await listHosts(paths));
  if (running) {
    // Pi already runs this Session, so options that would start it differently do not apply.
    const ignored = args.filter((arg, i) => !['--session', '--session-dir', '-c', '--continue'].includes(arg)
      && !arg.startsWith('--session=') && !['--session', '--session-dir'].includes(args[i - 1]));
    if (ignored.length) process.stderr.write(`The Session is already running; attaching without applying: ${ignored.join(' ')}\n`);
  }
  const socket = running?.socket ?? await startHost(paths, {
    pi: real, args, cwd: process.cwd(), cols: process.stdout.columns, rows: process.stdout.rows, waitForTerminal: true,
  });
  await attachAndReport(socket);
}
