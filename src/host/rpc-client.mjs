// `pd -p`, `pd --mode json`, and `pd --mode rpc`: Pi's non-interactive modes as clients of a Session in
// a host, which other clients and an attached terminal can use at the same time.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, hostSessionFile, hostStatus, settledHosts, startHost } from './client.mjs';
import { readSessionHeader, readSessionId } from '../roots/guard.mjs';
import { openStream, request } from '../roots/transport.mjs';
import { piPackage } from '../pi.mjs';
import { PROGRAM_MESSAGE, runOutput } from '../programs/run-output.mjs';

const TIMEOUT_MS = 30000;
const NOT_READY = ['ENOENT', 'ECONNREFUSED', 'SOCKET_MODE', 'NOT_READY'];
const GONE = ['ENOENT', 'ECONNREFUSED', 'ECONNRESET'];
// Options that choose the Session; another Session opens with the rest.
const SESSION_OPTIONS = new Set(['--session', '--session-id', '--fork', '--name', '-n', '-c', '--continue', '-r', '--resume']);

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function stopped(paths) {
  return fault('HOST_STOPPED', `Pi stopped before the Session was ready. See ${paths.hostLog}`);
}

/** Opens a `role` stream to Session `id` once its Pi is ready, while `live()` holds. */
async function connect(paths, id, handlers, live, role = 'rpc') {
  const socket = paths.session(id);
  const deadline = performance.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const status = await request(socket, { action: 'status' });
      if (status.ready) {
        if (status.availabilityError) throw new Error(status.availabilityError);
        return { status, stream: await openStream(socket, { action: 'stream', role }, handlers) };
      }
    } catch (error) { if (!NOT_READY.includes(error.code)) throw error; }
    if (!live()) throw stopped(paths);
    if (performance.now() > deadline) throw new Error(`The Session did not become ready. See ${paths.hostLog}`);
    await delay(50);
  }
}

/**
 * Whether Pi's `parseArgs` reads `next` as the value of `arg`. It decides by the form of `next`, so a probe of that form
 * shows it: the probe is consumed, or parsed on its own as a message, a file, an unknown short option, or an unknown flag.
 */
function takesValue(parseArgs, arg, next) {
  const probe = next.startsWith('---') ? '---\0' : next.startsWith('-') ? '-\0' : next.startsWith('@') ? '@\0' : '\0';
  const parsed = parseArgs([arg, probe]);
  if (probe === '\0') return !parsed.messages.includes(probe);
  if (probe === '@\0') return !parsed.fileArgs.includes('\0');
  // Only Pi's own diagnostic for the probe alone; an option may consume it and report it as an invalid value.
  if (probe === '-\0') return !parsed.diagnostics.some(({ message }) => message === `Unknown option: ${probe}`);
  return !parsed.unknownFlags.has('-\0');
}

/** `args` in the groups Pi reads: an option with its value, or an argument alone; from `--` on, one group. */
export function argGroups(parseArgs, args) {
  const groups = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      groups.push(args.slice(i));
      break;
    }
    groups.push(i + 1 < args.length && takesValue(parseArgs, args[i], args[i + 1]) ? [args[i], args[++i]] : [args[i]]);
  }
  return groups;
}

/** `args` without the prompts, and without the options that make Pi non-interactive. */
function withoutPrompts(parseArgs, args) {
  return argGroups(parseArgs, args).filter(group => {
    const parsed = parseArgs(group);
    return !parsed.messages.length && !parsed.fileArgs.length && !['-p', '--print', '--mode'].includes(group[0]);
  }).flat();
}

/** The prompts Pi sends on startup for `parsed`: its initial message, then each further message. */
async function startupPrompts(dist, parsed, stdinContent) {
  const { buildInitialMessage } = await dist('cli/initial-message.js');
  let files = {};
  if (parsed.fileArgs.length) {
    const { processFileArguments } = await dist('cli/file-processor.js');
    const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
    files = { fileText: text, fileImages: images };
  }
  const { initialMessage, initialImages } = buildInitialMessage({ parsed, stdinContent, ...files });
  return [...(initialMessage ? [{ message: initialMessage, images: initialImages }] : []), ...parsed.messages.map(message => ({ message }))];
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Runs Pi's `mode` ('text', 'json', or 'rpc') for `args` on a hosted Session: the host `findRunning` resolves to,
 * already holding the Session `args` choose, or a new host. `warnIgnored` reports the options a running host does not apply.
 */
export async function runHeadless({ pi, paths, args, mode, findRunning, warnIgnored }) {
  const dist = file => import(pathToFileURL(`${piPackage(pi)}/dist/${file}`).href);
  const { parseArgs } = await dist('cli/args.js');
  const parsed = parseArgs(args);
  if (mode === 'rpc' && parsed.fileArgs.length) {
    process.stderr.write('Error: @file arguments are not supported in RPC mode\n');
    process.exit(1);
  }

  // The host runs Pi without the prompts, which arrive as RPC commands instead.
  const hostArgs = withoutPrompts(parseArgs, args);
  const sessionArgs = argGroups(parseArgs, hostArgs).filter(([option]) => !SESSION_OPTIONS.has(option)).flat();

  /** Starts a host for `hostArgs` in `cwd`; resolves once its Pi reports the Session. */
  async function host(hostArgs, cwd) {
    const socket = await startHost(paths, { pi, args: hostArgs, cwd, waitForTerminal: false });
    const deadline = performance.now() + TIMEOUT_MS;
    for (;;) {
      let status;
      try { status = await hostStatus(socket); }
      catch (error) { throw GONE.includes(error.code) ? stopped(paths) : error; }
      if (status.session?.id) return status;
      if (performance.now() > deadline) throw new Error(`Pi did not start. See ${paths.hostLog}`);
      await delay(50);
    }
  }

  /** Connects to the Session in `file`, starting it in a host in `cwd` if no Pi runs it. */
  async function open(file, cwd, handlers) {
    // A Session Pi created in a relative session directory has a relative file.
    file = resolve(cwd, file);
    const deadline = performance.now() + TIMEOUT_MS;
    for (;;) {
      const id = readSessionId(file);
      const holds = h => h.session && (h.session.id === id || hostSessionFile(h) === file);
      try {
        const held = (await settledHosts(paths, holds)).find(holds);
        if (held) return await connect(paths, held.session.id, handlers, () => alive(held.pid));
        if (id && await request(paths.session(id), { action: 'status' }).then(() => true, () => false)) {
          return await connect(paths, id, handlers, () => true);
        }
        const status = await host([...sessionArgs, '--session', file], cwd);
        return await connect(paths, status.session.id, handlers, () => alive(status.pid));
      } catch (error) {
        // Its Pi may be stopping, another client may have just started it, or its previous Pi may still hold its lock.
        if (error.code !== 'HOST_STOPPED' || performance.now() > deadline) throw error;
      }
      await delay(200);
    }
  }

  /** Opens a `role` stream to the Session `args` choose. */
  async function start(handlers, role) {
    let running = await findRunning(), status;
    if (!running) {
      try { status = await host(hostArgs, process.cwd()); }
      catch (error) {
        // Another client may have started the same Session first.
        if (error.code !== 'HOST_STOPPED' || !(running = await findRunning())) throw error;
      }
    }
    if (!running) return connect(paths, status.session.id, handlers, () => alive(status.pid), role);
    warnIgnored(hostArgs);
    return connect(paths, running.session.id, handlers, () => alive(running.pid), role);
  }

  try {
    if (mode === 'rpc') await rpc({ start, open, dist });
    else await print({ start, parsed, mode, dist });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Prepares the messages in `args` for the Session in the host `running`, as Pi sends them on startup; `warnIgnored`
 * reports the other options, which a running host does not apply. Resolves to a function that sends them, each as a
 * follow-up once the previous one is accepted, and resolves to the error that stopped it, if any.
 */
export async function startupMessages({ pi, paths, args, running, warnIgnored }) {
  const dist = file => import(pathToFileURL(`${piPackage(pi)}/dist/${file}`).href);
  const { parseArgs } = await dist('cli/args.js');
  warnIgnored(withoutPrompts(parseArgs, args));
  const prompts = await startupPrompts(dist, parseArgs(args));
  return async () => {
    if (!prompts.length) return;
    try {
      let answer;
      const { stream } = await connect(paths, running.session.id, {
        onMessage(value) { if (value.type === 'response') answer?.(value); },
        onClose() { answer?.({ success: false, error: 'The Session stopped.' }); },
      }, () => alive(running.pid));
      for (const { message, images } of prompts) {
        const response = await new Promise(resolve => {
          answer = resolve;
          stream.send({ type: 'prompt', message, images, streamingBehavior: 'followUp' });
        });
        if (!response.success) throw new Error(response.error);
      }
      stream.close();
    } catch (error) {
      return error.message;
    }
  };
}

async function print({ start, parsed, mode, dist }) {
  let stdinContent;
  if (!process.stdin.isTTY) {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    stdinContent = data.trim() || undefined;
  }
  const prompts = await startupPrompts(dist, parsed, stdinContent);

  // The host runs the prompts once the Session is idle, and sends the events of their turns.
  let header, last, stopping, done = false, finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const { stream } = await start({
    onMessage(value) {
      if (value.start && mode === 'json' && header) write(header);
      if (value.event) {
        if (mode === 'json') write(value.event);
        if (value.event.type === 'message_end') {
          last = value.event.message;
          // A `/program` run prints when it ends, as with `pi -p`; a failed one sets status 1.
          if (mode === 'text' && last.role === 'custom' && last.customType === PROGRAM_MESSAGE) {
            const body = runOutput(last.content.slice(1));
            if (last.details?.isError) {
              process.stderr.write(`${body}\n`);
              process.exitCode = 1;
            } else process.stdout.write(`${body}\n`);
          }
        }
      }
      if (value.end) finish(value);
    },
    onClose() {
      if (done) return;
      if (stopping !== undefined) process.exit(stopping);
      process.stderr.write('The Session stopped.\n');
      process.exit(1);
    },
  }, 'print');
  header = stream.result.header;

  // A signal withdraws the prompts or stops their turn, and exits with Pi's code; a second one exits at once.
  for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })) {
    process.on(signal, () => {
      if (stopping !== undefined) process.exit(stopping);
      stopping = code;
      stream.send({ type: 'stop' });
    });
  }
  stream.send({ type: 'run', prompts });
  const end = await finished;
  done = true;
  stream.close();
  if (stopping !== undefined) {
    process.exitCode = stopping;
    return;
  }
  if (end.error) throw new Error(end.error);
  if (mode === 'text' && last?.role === 'assistant') {
    if (last.stopReason === 'error' || last.stopReason === 'aborted') {
      process.stderr.write(`${last.errorMessage || `Request ${last.stopReason}`}\n`);
      process.exitCode = 1;
    }
    else {
      for (const content of last.content) if (content.type === 'text') process.stdout.write(`${content.text}\n`);
      // As Pi's print mode does.
      if (last.stopReason === 'length') {
        process.stderr.write('Response was truncated: the model reached its output token limit.\n');
        process.exitCode = 1;
      }
    }
  }
}

async function rpc({ start, open, dist }) {
  const { attachJsonlLineReader } = await dist('modes/rpc/jsonl.js');
  let current, reopening, queue = Promise.resolve();
  const enqueue = task => { queue = queue.then(task).catch(fail); };
  const failure = (command, error) => ({ id: command.id, type: 'response', command: command.type, success: false, error });

  function fail(error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  /** A connection made by `connecting`; it delivers until another replaces it. */
  async function connection(connecting) {
    // Commands sent on this connection that await their response; `resolve` takes it instead of stdout.
    const conn = { retired: false, pending: [] };
    Object.assign(conn, await connecting({
      onMessage(value) {
        if (conn.retired) return;
        if (value.type === 'response') {
          const at = conn.pending.findIndex(entry => entry.command.id === value.id && entry.command.type === value.command);
          const [entry] = at >= 0 ? conn.pending.splice(at, 1) : [];
          if (entry?.resolve) return entry.resolve(value);
        }
        write(value);
      },
      onClose() {
        if (conn.retired) return;
        retire(conn, 'The Session stopped.');
        // The host stopped or moved to another Session: open this one again.
        reopening = connection(handlers => open(conn.status.sessionFile, conn.status.cwd, handlers)).then(next => {
          if (current === conn) return use(next);
          next.retired = true;
          next.stream.close();
        }, fail);
      },
    }));
    return conn;
  }

  /** Sends `command` to the current Session; with `resolve`, its response goes there. */
  function send(command, resolve) {
    if (current.retired) return (resolve ?? write)(failure(command, 'The Session stopped.'));
    if (command?.type !== 'extension_ui_response') current.pending.push({ command, resolve });
    current.stream.send(command);
  }

  /** Stops delivering `conn`; a command still awaiting its response may have run or not, so it is answered, not sent again. */
  function retire(conn, reason) {
    conn.retired = true;
    for (const { command, resolve } of conn.pending.splice(0)) (resolve ?? write)(failure(command, reason));
  }

  function use(conn) {
    const previous = current;
    current = conn;
    if (previous && !previous.retired) {
      retire(previous, 'The client moved to another Session.');
      previous.stream.close();
    }
  }

  async function move(command, file, cwd, response) {
    try {
      use(await connection(handlers => open(file, cwd, handlers)));
      write(response);
    } catch (error) {
      write({ id: command.id, type: 'response', command: command.type, success: false, error: error.message });
    }
  }

  async function handle(line) {
    await reopening;
    let command;
    try { command = JSON.parse(line); }
    catch (error) {
      return write({ type: 'response', command: 'parse', success: false, error: `Failed to parse command: ${error.message}` });
    }
    if (command?.type === 'switch_session') {
      const file = resolve(command.sessionPath);
      const cwd = readSessionHeader(file)?.cwd ?? current.status.cwd;
      return move(command, file, cwd, { id: command.id, type: 'response', command: command.type, success: true, data: { cancelled: false } });
    }
    if (['new_session', 'fork', 'clone'].includes(command?.type)) {
      // The Session creates the new Session, which only this client moves to.
      const response = await new Promise(resolve => send(command, resolve));
      if (!response.success || !response.data?.sessionFile) return write(response);
      const { sessionFile, ...data } = response.data;
      return move(command, sessionFile, current.status.cwd, { ...response, data });
    }
    send(command);
  }

  use(await connection(start));
  attachJsonlLineReader(process.stdin, line => enqueue(() => handle(line)));
  process.stdin.on('end', () => enqueue(async () => {
    await reopening;
    current.retired = true;
    current.stream.close();
  }));
}
