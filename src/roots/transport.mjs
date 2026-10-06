import net from 'node:net';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const MAX_SOCKET_PATH_BYTES = 103;
const MAX_PENDING = 64;
const TIMEOUT_MS = 10000;

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateSocketPath(path) {
  if (Buffer.byteLength(path, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    throw fault('SOCKET_PATH_TOO_LONG', `Unix socket paths must fit within ${MAX_SOCKET_PATH_BYTES} UTF-8 bytes; use a shorter PI_AGENTS_STATE_DIR: ${path}`);
  }
}

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function safeDirectory(path, create = false) {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
    throw fault('UNSAFE_PATH', 'Socket parent must be owned by the current user and not group/world writable');
  }
}

function privateSocket(path) {
  safeDirectory(dirname(path));
  const info = lstatSync(path);
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
    throw fault('UNSAFE_PATH', 'Socket must be owned by the current user with mode 0600');
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

function validate(value) {
  if (!record(value)) throw fault('INVALID_REQUEST', 'Expected a request object');
  if (value.action === 'status') return { action: 'status' };
  const m = value.message;
  if (value.action !== 'deliver' || !record(m) || !text(m.id) || !record(m.sender)
    || !text(m.sender.id) || (m.sender.name !== undefined && !text(m.sender.name))
    || !text(m.recipient) || !text(m.body)) {
    throw fault('INVALID_REQUEST', 'Expected status or deliver with nonempty message id, sender, recipient and body');
  }
  if (m.deliverAs !== undefined && m.deliverAs !== 'followUp' && m.deliverAs !== 'steer' && m.deliverAs !== 'write') {
    throw fault('INVALID_REQUEST', 'deliverAs must be followUp, steer or write');
  }
  return { action: 'deliver', message: {
    id: m.id, sender: { id: m.sender.id, ...(m.sender.name === undefined ? {} : { name: m.sender.name }) },
    recipient: m.recipient, body: m.body,
    ...(m.deliverAs === undefined ? {} : { deliverAs: m.deliverAs }),
  } };
}

function encode(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_BYTES) throw fault('FRAME_TOO_LARGE', 'JSONL frame exceeds 1 MiB');
  return bytes;
}

// Consume exactly one bounded JSONL frame; never dispatch additional requests.
function readFrame(socket, done) {
  let chunks = [], size = 0, finished = false;
  function finish(error, value) {
    if (finished) return;
    finished = true;
    chunks = [];
    done(error, value);
  }
  socket.on('data', chunk => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_BYTES) return finish(fault('FRAME_TOO_LARGE', 'JSONL frame exceeds 1 MiB'));
    chunks.push(chunk);
    const newline = chunk.indexOf(10);
    if (newline < 0) return;
    if (newline !== chunk.length - 1) return finish(fault('INVALID_FRAME', 'Expected one JSONL frame'));
    try {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const value = JSON.parse(source);
      finish(null, value);
    } catch { finish(fault('INVALID_FRAME', 'Invalid JSONL frame')); }
  });
  socket.on('end', () => finish(fault('INVALID_FRAME', 'Connection ended before a complete JSONL frame')));
}

function errorFrame(error) {
  return encode({ ok: false, error: {
    code: typeof error?.code === 'string' ? error.code : 'HANDLER_ERROR',
    message: typeof error?.message === 'string' ? error.message.slice(0, 4096) : 'Worker handler failed',
    ...(typeof error?.uncertainDelivery === 'boolean' ? { uncertainDelivery: error.uncertainDelivery } : {}),
  } });
}

/** FIFO by default. Handlers receive a connection-lifetime signal, not an acceptance rollback. */
export async function listenWorker(socketPath, { status, accept, serialize = true }) {
  socketPath = resolve(socketPath);
  validateSocketPath(socketPath);
  const parent = dirname(socketPath);
  safeDirectory(parent, true);
  if (stat(socketPath)) throw fault('EADDRINUSE', 'Socket path already exists');
  // Node unconditionally unlinks its bind path on close. Publish a hard link so
  // replacing the public path cannot cause Node to delete someone else's file.
  const bindingDir = mkdtempSync(join(parent, '.w-'));
  const bindingPath = join(bindingDir, 's');
  const clients = new Map();
  const queued = new Map();
  const closedError = Object.assign(fault('WORKER_CLOSED', 'Worker is closing; request was not invoked'), { uncertainDelivery: false });
  let queue = Promise.resolve(), pending = 0, closing, lastActivity = Date.now();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    const controller = new AbortController();
    const { signal } = controller;
    clients.set(socket, controller);
    lastActivity = Date.now();
    function disconnect() {
      controller.abort();
      queued.get(socket)?.(signal.reason);
      queued.delete(socket);
    }
    socket.on('error', () => { disconnect(); socket.destroy(); });
    const timer = setTimeout(() => { disconnect(); socket.destroy(); }, TIMEOUT_MS);
    socket.on('close', () => { disconnect(); clearTimeout(timer); clients.delete(socket); lastActivity = Date.now(); });
    function respond(error, result) {
      if (socket.destroyed || socket.writableEnded) return;
      let bytes;
      try { bytes = error ? errorFrame(error) : encode({ ok: true, result }); }
      catch (failure) { bytes = errorFrame(failure); }
      socket.end(bytes);
    }
    readFrame(socket, (error, value) => {
      if (error) return respond(error);
      let input;
      try { input = validate(value); }
      catch (failure) { return respond(failure); }
      if (pending >= MAX_PENDING) return respond(fault('WORKER_BUSY', 'Worker request queue is full'));
      pending++;
      const serialized = serialize && input.action !== 'status';
      const work = new Promise((resolve, reject) => {
        queued.set(socket, reject);
        const invocation = (serialized ? queue : Promise.resolve()).then(async () => {
          queued.delete(socket);
          if (closing) throw closedError;
          signal.throwIfAborted();
          if (input.action === 'status') return status({ signal });
          return accept(input.message, { signal });
        });
        // Cancelling a queued response must not let later requests bypass its predecessor.
        if (serialized) queue = invocation.catch(() => {});
        invocation.then(resolve, reject).finally(() => { pending--; lastActivity = Date.now(); });
      });
      work.then(result => respond(null, result), respond);
    });
    // Clients keep the write side open until acknowledgement. EOF also signals
    // sender exit; allowHalfOpen otherwise delays close until the handler returns.
    socket.on('end', () => { disconnect(); socket.destroySoon(); });
  });
  server.maxConnections = MAX_PENDING;
  try {
    validateSocketPath(bindingPath);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(bindingPath, () => { server.removeListener('error', reject); resolve(); });
    });
    // The 0700 binding directory hides the socket until its permissions are set,
    // including when the public parent is readable by other users.
    chmodSync(bindingPath, 0o600);
    linkSync(bindingPath, socketPath);
  } catch (error) {
    await new Promise(resolve => server.close(resolve));
    rmdirSync(bindingDir);
    if (error.code === 'EEXIST') throw fault('EADDRINUSE', 'Socket path already exists');
    throw error;
  }
  const owned = lstatSync(bindingPath);
  return {
    closeIfIdle(idleMs) {
      if (clients.size || pending || Date.now() - lastActivity < idleMs) return;
      return this.close();
    },
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(() => new Promise((resolve, reject) => {
        const current = stat(socketPath);
        if (current?.isSocket() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(socketPath);
        for (const [socket, reject] of queued) {
          reject(closedError);
          if (!socket.destroyed && !socket.writableEnded) socket.end(errorFrame(closedError));
          socket.destroySoon();
        }
        for (const [socket, controller] of clients) {
          controller.abort();
          if (!queued.has(socket)) socket.destroy();
        }
        queued.clear();
        server.close(error => {
          try { rmdirSync(bindingDir); }
          catch (failure) { reject(failure); return; }
          if (error) reject(error); else resolve();
        });
      }));
      return closing;
    },
  };
}

/**
 * No retries. Timeout/cancellation of deliver always reports uncertainDelivery.
 * @param {string} socketPath
 * @param {object} input
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function request(socketPath, input, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  const value = validate(input);
  const bytes = encode(value);
  const interrupted = (code, message) => Object.assign(fault(code, message
    + (value.action === 'deliver' ? '; delivery is uncertain: the recipient may have received it' : '')),
  { uncertainDelivery: value.action === 'deliver' });
  if (signal?.aborted) throw interrupted('ABORT_ERR', 'Request cancelled');
  socketPath = resolve(socketPath);
  validateSocketPath(socketPath);
  privateSocket(socketPath);
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let settled = false, sent = false;
    function finish(error, result, remote = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) {
        if (!remote && sent && value.action === 'deliver') error.uncertainDelivery = true;
        reject(error);
      } else resolve(result);
    }
    const abort = () => finish(interrupted('ABORT_ERR', 'Request cancelled'));
    const timer = setTimeout(() => finish(interrupted('ETIMEDOUT', 'Acknowledgement timed out')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(fault('CONNECTION_CLOSED', 'Connection closed before acknowledgement')));
    socket.on('connect', () => { sent = true; socket.write(bytes); });
    readFrame(socket, (error, response) => {
      if (error) return finish(error);
      if (record(response) && response.ok === true && Object.hasOwn(response, 'result')) return finish(null, response.result);
      if (record(response) && response.ok === false && record(response.error)
        && text(response.error.code) && typeof response.error.message === 'string') {
        const failure = fault(response.error.code, response.error.message);
        if (typeof response.error.uncertainDelivery === 'boolean') failure.uncertainDelivery = response.error.uncertainDelivery;
        return finish(failure, undefined, true);
      }
      finish(fault('INVALID_RESPONSE', 'Invalid worker response'));
    });
  });
}
