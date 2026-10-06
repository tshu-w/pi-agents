import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { listenWorker, request } from '../src/roots/transport.mjs';
import { sendViaSupervisor } from '../src/roots/client.mjs';
import { createSupervisor } from '../src/roots/supervisor.mjs';

const message = { id: 'idle-message', sender: { id: 'sender' }, recipient: 'recipient', body: 'hello' };

test('a caller that stops waiting does not cancel a wake shared with a longer caller', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let wakes = 0, wakeSignal, ready = false;
  const router = createSupervisor({
    deliverToWorker: async input => {
      if (!ready) throw Object.assign(new Error('Offline'), { code: 'ENOENT' });
      return { accepted: true, messageId: input.id };
    },
    wake: async (_id, { signal }) => {
      wakes++;
      wakeSignal = signal;
      await new Promise(resolve => setTimeout(resolve, 50));
      signal.throwIfAborted();
      ready = true;
    },
  });
  const short = assert.rejects(router.accept(message, { timeoutMs: 20 }), { code: 'ETIMEDOUT', uncertainDelivery: false });
  const long = router.accept(message, { timeoutMs: 100 });
  while (!wakes) await new Promise(resolve => setImmediate(resolve));
  assert.equal(wakes, 1);
  t.mock.timers.tick(20);
  await short;
  assert.equal(wakeSignal.aborted, false);
  t.mock.timers.tick(30);
  assert.deepEqual(await long, { accepted: true, messageId: message.id });
  assert.equal(wakes, 1);
});

test('idle close waits for connections, handlers and acknowledgements', async t => {
  const directory = await mkdtemp('/tmp/pa-idle-');
  const path = join(directory, 's');
  let finish;
  const entered = Promise.withResolvers();
  const server = await listenWorker(path, {
    status: () => ({ ready: true }),
    accept: async () => {
      entered.resolve();
      await new Promise(resolve => { finish = resolve; });
      return { accepted: true, messageId: message.id };
    },
  });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const socket = net.connect(path);
  await once(socket, 'connect');
  t.after(() => socket.destroy());
  await delay(25);
  assert.equal(server.closeIfIdle(10), undefined);
  socket.destroy();
  await once(socket, 'close');

  const receipt = request(path, { action: 'deliver', message });
  await entered.promise;
  await delay(25);
  assert.equal(server.closeIfIdle(10), undefined);
  finish();
  assert.deepEqual(await receipt, { accepted: true, messageId: message.id });
  assert.equal(server.closeIfIdle(10), undefined);
  await delay(25);
  await server.closeIfIdle(10);
  await assert.rejects(request(path, { action: 'status' }), { code: 'ENOENT' });
});

test('client retries a disconnected status but never replays uncertain delivery', async t => {
  const directory = await mkdtemp('/tmp/pa-idle-');
  const paths = { directory, supervisor: join(directory, 's') };
  let calls = 0, statuses = 0;
  const server = net.createServer(socket => {
    socket.on('data', bytes => {
      const input = JSON.parse(bytes.toString());
      if (input.action === 'status') {
        if (++statuses === 1) { socket.destroy(); return; }
        socket.end(JSON.stringify({ ok: true, result: { ready: true } }) + '\n');
      } else {
        calls++;
        socket.end(JSON.stringify({ ok: false, error: {
          code: 'WORKER_CLOSED', message: 'Accepted but acknowledgement lost', uncertainDelivery: true,
        } }) + '\n');
      }
    });
  });
  server.listen(paths.supervisor);
  await once(server, 'listening');
  await chmod(paths.supervisor, 0o600);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(sendViaSupervisor(paths, message, {}), { code: 'WORKER_CLOSED', uncertainDelivery: true });
  assert.equal(calls, 1);
});

test('supervisor preserves a spawned worker, exits idle and restarts on demand', async t => {
  const directory = await mkdtemp('/tmp/pa-idle-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = relative => new URL(relative, import.meta.url).href;
  await mkdir(join(directory, 'sessions', 'root'), { recursive: true });
  await writeFile(join(directory, 'sessions', 'root', 'recipient.jsonl'), JSON.stringify({
    type: 'session', version: 3, id: 'recipient', cwd: directory, timestamp: new Date().toISOString(),
  }) + '\n');
  // Accelerate only the isolated subprocess clock, with no production option.
  await writeFile(join(directory, 'clock.mjs'), `
    const now = Date.now;
    Date.now = () => now() * 100;
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms / 100, ...args);
  `);
  await writeFile(join(directory, 'pi.mjs'), `
    export const parseSessionEntries = () => [];
    export const buildSessionContext = () => ({});
  `);
  await writeFile(join(directory, 'worker.mjs'), `
    import { rootPaths } from '${url('../src/roots/paths.mjs')}';
    import { listenWorker } from '${url('../src/roots/transport.mjs')}';
    const server = await listenWorker(rootPaths().worker('recipient'), {
      status: () => ({ id: 'recipient', cwd: ${JSON.stringify(directory)}, ready: true }),
      accept: message => ({ accepted: true, messageId: message.id }),
    });
    const exit = async () => { await server.close(); process.exit(0); };
    process.once('SIGTERM', exit);
    setTimeout(exit, 800);
  `);
  await writeFile(join(directory, 'runner.mjs'), `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { rootPaths } from '${url('../src/roots/paths.mjs')}';
    import { listenWorker, request } from '${url('../src/roots/transport.mjs')}';
    import { prepareDirectory } from '${url('../src/roots/registry.mjs')}';
    import { acquireOwnership } from '${url('../src/roots/ownership.mjs')}';
    import { sendViaSupervisor } from '${url('../src/roots/client.mjs')}';
    const paths = rootPaths();
    const options = ${JSON.stringify({ cli: join(directory, 'worker.mjs'), sessionRoot: join(directory, 'sessions'), piIndex: join(directory, 'pi.mjs'), extension: 'unused' })};
    const message = ${JSON.stringify(message)};
    let pid;
    await prepareDirectory(paths.directory);
    const lease = acquireOwnership({ stateDir: paths.ownership, sessionId: 'supervisor', sessionFile: paths.supervisor });
    const retiring = await listenWorker(paths.supervisor, {
      status: () => ({ ready: true }),
      accept: () => {
        setTimeout(() => retiring.close(), 0);
        setTimeout(() => lease.release(), 200);
        throw Object.assign(new Error('Closing before invocation'), { code: 'WORKER_CLOSED', uncertainDelivery: false });
      },
    });
    try {
      assert.equal((await sendViaSupervisor(paths, message, options)).accepted, true);
      pid = (await request(paths.supervisor, { action: 'status' })).pid;
      await delay(450);
      process.kill(pid, 0);
      // A status request would count as activity, so watch the socket file. Date.now runs fast
      // here, so the 5 s cap counts polls.
      for (let i = 0; i < 250 && existsSync(paths.supervisor); i++) await delay(20);
      await assert.rejects(request(paths.supervisor, { action: 'status' }), { code: 'ENOENT' });
      const first = pid;
      assert.equal((await sendViaSupervisor(paths, { ...message, id: 'second' }, options)).accepted, true);
      pid = (await request(paths.supervisor, { action: 'status' })).pid;
      assert.notEqual(pid, first);
    } finally {
      try { pid = (await request(paths.supervisor, { action: 'status' })).pid; } catch {}
      if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      await retiring.close();
      lease.release();
      await delay(100);
    }
  `);
  const child = spawn(process.execPath, [join(directory, 'runner.mjs')], {
    env: { ...process.env, PI_AGENTS_STATE_DIR: join(directory, 'state'), NODE_OPTIONS: `--import=${join(directory, 'clock.mjs')}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
});
