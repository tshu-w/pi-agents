// Runs one interactive Pi in a pseudo-terminal and relays it to at most one attached terminal.
// Started detached by `pi` or the daemon; exits when Pi exits.
import { rmSync } from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { FRAME, frame, json, readFrames } from '../src/host/frames.mjs';
import { prepareDirectory, statePaths } from '../src/roots/paths.mjs';

const require = createRequire(import.meta.url);
const pty = require('@lydell/node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const config = JSON.parse(process.env.PI_AGENTS_HOST_CONFIG);
const paths = statePaths();
const socketPath = paths.host(process.pid);

// Terminal modes Pi sets that the screen mirror does not keep; replayed to each newly attached terminal.
const MODE = /\x1b\[>\d*u|\x1b\[<\d*u|\x1b\[>4;\d*m|\x1b\[\?(?:2031|2004|1000|1002|1003|1006|1004|25)[hl]|\x1b\](?:0|2|7501);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const modes = new Map();
function trackModes(data) {
  for (const [sequence] of data.matchAll(MODE)) {
    if (sequence.startsWith('\x1b[<')) modes.delete('keyboard');
    else if (sequence.startsWith('\x1b[>4;')) modes.set('modifyOtherKeys', sequence);
    else if (sequence.startsWith('\x1b[>')) modes.set('keyboard', sequence);
    else if (sequence.startsWith('\x1b[?')) modes.set(sequence.slice(0, -1), sequence);
    // Program status (OSC 7501): Pi reports it only on change, so a terminal attaching later needs the last one.
    else if (sequence.startsWith('\x1b]7501;state=clear')) modes.delete('status');
    else if (sequence.startsWith('\x1b]7501;')) modes.set('status', sequence);
    else modes.set('title', sequence);
  }
}

// Pi's startup queries: keyboard protocol, program status, device attributes, and colors. Pi waits for the
// replies, so those it sent before any terminal attached are passed to the first one.
const QUERY = /\x1b\[\?u|\x1b\[c|\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\](?:10|11|4;\d+);\?(?:\x07|\x1b\\)/g;
let queries = '';
let attachedOnce = false;

// Pi's output may split a control sequence across chunks; its unfinished end waits for the next chunk.
const SEQUENCE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
let partial = '';
function completed(data) {
  const text = partial + data;
  const start = Math.max(text.lastIndexOf('\x1b['), text.lastIndexOf('\x1b]'));
  const end = start >= 0 && !SEQUENCE.test(text.slice(start)) ? start : text.endsWith('\x1b') ? text.length - 1 : text.length;
  partial = text.length - end > 4096 ? '' : text.slice(end);
  return text.slice(0, end);
}

const COLOR_SCHEME_REPORT = /\x1b\[\?997;([12])n/;
const COLOR_SCHEME_WAIT_MS = 300;
let colorScheme = '1';
let session, terminal, control, child;

await prepareDirectory(paths.runtime);
rmSync(socketPath, { force: true });

const env = { ...process.env, PI_AGENTS_HOST: socketPath, PI_AGENTS_HOST_PID: String(process.pid) };
delete env.PI_AGENTS_HOST_CONFIG;
const mirror = new Terminal({ cols: config.cols, rows: config.rows, allowProposedApi: true, scrollback: 1000 });
const serializer = new SerializeAddon();
mirror.loadAddon(serializer);

function start({ cols, rows }) {
  mirror.resize(cols, rows);
  child = pty.spawn(config.pi, config.args, { name: env.TERM || 'xterm-256color', cols, rows, cwd: config.cwd, env });
  child.onData(data => {
    const text = completed(data);
    trackModes(text);
    if (!attachedOnce) for (const [query] of text.matchAll(QUERY)) queries += query;
    mirror.write(data);
    terminal?.socket.write(frame(FRAME.data, data));
  });
  child.onExit(({ exitCode }) => {
    server.close();
    rmSync(socketPath, { force: true });
    // Pi's last output can arrive after its exit; let it through before the final frame.
    setTimeout(() => {
      terminal?.socket.end(frame(FRAME.exited, { session, exitCode }));
      setTimeout(() => process.exit(0), 100).unref();
    }, 100);
  });
}
// Started for a terminal, Pi waits for it, so its startup queries reach the terminal.
if (!config.waitForTerminal) start(config);
else setTimeout(() => { if (!child) process.exit(0); }, 10000).unref();

function resize({ cols, rows }) {
  mirror.resize(cols, rows);
  child.resize(cols, rows);
}

// Moves the cursor below the screen's content, so what the terminal prints next does not overwrite it.
function belowContent() {
  const buffer = mirror.buffer.active;
  if (buffer.type !== 'normal') return '';
  const cursor = buffer.baseY + buffer.cursorY;
  let last = buffer.length - 1;
  while (last > cursor && !buffer.getLine(last)?.translateToString(true).trim()) last--;
  return last > cursor ? `\x1b[${last - cursor}B` : '';
}

function detach(reason) {
  terminal.socket.write(frame(FRAME.data, belowContent()));
  terminal.socket.end(frame(FRAME.detached, { reason, session }));
}

function setAttached(next) {
  if (terminal && next !== terminal) detach('takeover');
  terminal = next;
  control?.write(frame(FRAME.control, { type: 'attached', attached: Boolean(terminal) }));
}

function attach(socket, size) {
  const next = { socket, colorReply: false };
  setAttached(next);
  const first = !attachedOnce;
  attachedOnce = true;
  if (!child) return start(size);
  resize(size);
  socket.write(frame(FRAME.data, '\x1b[H\x1b[2J' + serializer.serialize() + [...modes.values()].join('') + (first ? queries : '') + partial));
  queries = '';
  // Pi re-queries the terminal's colors when it receives a color scheme report.
  if (modes.get('\x1b[?2031') === '\x1b[?2031h') {
    socket.write(frame(FRAME.data, '\x1b[?996n'));
    setTimeout(() => { if (terminal === next && !next.colorReply) child.write(`\x1b[?997;${colorScheme}n`); }, COLOR_SCHEME_WAIT_MS);
  }
  // A size change makes Pi redraw, which brings back images the mirror cannot keep.
  child.resize(Math.max(size.cols - 1, 1), size.rows);
  setTimeout(() => { if (terminal === next) child.resize(size.cols, size.rows); }, 100);
}

function status() {
  return { pid: process.pid, cwd: config.cwd, session, attached: Boolean(terminal) };
}

const server = net.createServer(socket => {
  socket.on('error', () => {});
  readFrames(socket, (type, body) => {
    if (type === FRAME.status) socket.end(frame(FRAME.status, status()));
    else if (type === FRAME.attach) attach(socket, json(body));
    else if (type === FRAME.resize && terminal?.socket === socket && child) resize(json(body));
    else if (type === FRAME.detached && terminal?.socket === socket) {
      detach('detach');
      setAttached(undefined);
    }
    else if (type === FRAME.data && terminal?.socket === socket && child) {
      const reply = body.toString('latin1').match(COLOR_SCHEME_REPORT);
      if (reply) { terminal.colorReply = true; colorScheme = reply[1]; }
      child.write(body);
    } else if (type === FRAME.control) {
      control = socket;
      const message = json(body);
      if (message.type === 'session') session = message.session;
      else if (message.type === 'detach' && terminal) {
        detach('detach');
        setAttached(undefined);
      }
      socket.write(frame(FRAME.control, { type: 'attached', attached: Boolean(terminal) }));
    }
  });
  socket.on('close', () => {
    if (terminal?.socket === socket) setAttached(undefined);
    if (control === socket) control = undefined;
  });
});
server.listen(socketPath);
process.on('SIGHUP', () => {});
process.on('SIGTERM', () => child ? child.kill('SIGTERM') : process.exit(0));
