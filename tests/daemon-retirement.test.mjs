import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { listen, openStream, request } from '../src/roots/transport.mjs';
import { sendViaDaemon } from '../src/daemon/client.mjs';
import { createRouter } from '../src/daemon/router.mjs';

const message = { id: 'retirement-message', sender: { id: 'sender' }, recipient: 'recipient', body: 'hello' };

for (const code of ['ENOENT', 'ECONNREFUSED']) {
  test(`remote ${code} is not retried by the daemon client or router`, async t => {
    const directory = await mkdtemp('/tmp/pa-retire-');
    const paths = { runtime: directory, daemon: join(directory, 's') };
    let calls = 0, wakes = 0;
    const server = await listen(paths.daemon, {
      status: () => ({ ready: true }),
      accept: () => {
        calls++;
        throw Object.assign(new Error('Recipient handler failed'), { code, uncertainDelivery: false });
      },
    });
    t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    await assert.rejects(sendViaDaemon(paths, message, { timeoutMs: 500 }), { code, remote: true, uncertainDelivery: false });
    assert.equal(calls, 1);
    const router = createRouter({
      deliverToSession: input => request(paths.daemon, { action: 'deliver', message: input }),
      wake: async () => { wakes++; },
    });
    await assert.rejects(router.accept(message), { code, remote: true, uncertainDelivery: false });
    assert.equal(calls, 2);
    assert.equal(wakes, 0);
  });
}

test('retirement drains incomplete requests and ACKs but closes long-lived streams', async t => {
  const directory = await mkdtemp('/tmp/pa-retire-');
  const path = join(directory, 's');
  const server = await listen(path, {
    status: () => ({ ready: true }),
    accept: input => ({ accepted: true, messageId: input.id }),
    stream: () => ({}),
  });
  const streamClosed = Promise.withResolvers();
  const stream = await openStream(path, { action: 'stream', role: 'session' }, {
    onMessage: () => {}, onClose: () => streamClosed.resolve(),
  });
  const socket = net.connect({ path, allowHalfOpen: true });
  t.after(async () => {
    socket.destroy();
    stream.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await once(socket, 'connect');
  socket.write('{"action":');
  // A status round trip ensures the server has accepted the incomplete connection.
  await request(path, { action: 'status' });
  assert.equal(server.closeIfDrained(), undefined);
  socket.write('"status"}\n');
  await once(socket, 'data');
  assert.equal(server.closeIfDrained(), undefined);
  socket.destroy();
  await once(socket, 'close');
  let closed;
  for (let i = 0; i < 100 && !closed; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    closed = server.closeIfDrained();
  }
  assert.ok(closed, 'long-lived streams do not block retirement');
  await closed;
  await streamClosed.promise;
});

test('a missing host runtime fails immediately with HOST_START_FAILED', async t => {
  const directory = await mkdtemp('/tmp/pa-retire-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { startHost } from '${new URL('../src/host/client.mjs', import.meta.url).href}';
    import { statePaths } from '${new URL('../src/roots/paths.mjs', import.meta.url).href}';
    const executable = process.execPath;
    Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(join(directory, 'missing-node'))} });
    await assert.rejects(startHost(statePaths(), {
      pi: executable, args: [], cwd: ${JSON.stringify(directory)},
    }), { code: 'HOST_START_FAILED' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PI_AGENTS_STATE_DIR: join(directory, 'state') },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null, 'spawn failure must not wait for the host readiness timeout');
  assert.equal(code, 0, output);
});

for (const busy of [false, true]) {
  test(`missing runtime retires the daemon ${busy ? 'after pending delivery and ACK connections' : 'on its timer'} and the next send restarts it`, async t => {
    const directory = await mkdtemp('/tmp/pa-retire-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const url = relative => new URL(relative, import.meta.url).href;
    const fake = join(directory, 'old-node');
    await writeFile(fake, '', { mode: 0o700 });
    await writeFile(join(directory, 'runtime.mjs'), `
      Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(fake)} });
      const interval = globalThis.setInterval;
      globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 1000 ? 25 : ms, ...args);
    `);
    await writeFile(join(directory, 'runner.mjs'), `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import { once } from 'node:events';
      import { existsSync } from 'node:fs';
      import { rm } from 'node:fs/promises';
      import { spawn } from 'node:child_process';
      import { setTimeout as delay } from 'node:timers/promises';
      import { statePaths, prepareDirectory } from '${url('../src/roots/paths.mjs')}';
      import { listen, request } from '${url('../src/roots/transport.mjs')}';
      import { sendViaDaemon } from '${url('../src/daemon/client.mjs')}';
      const paths = statePaths();
      const message = ${JSON.stringify(message)};
      const options = { sessionDir: ${JSON.stringify(directory)}, timeoutMs: 5000 };
      const waitFor = async predicate => {
        for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); }
        assert.fail('Condition did not become true');
      };
      await prepareDirectory(paths.runtime);
      let finish, entered = Promise.withResolvers(), calls = [];
      const recipient = await listen(paths.session('recipient'), {
        status: () => ({ ready: true }),
        accept: async input => {
          calls.push(input.id);
          if (input.id === 'busy') { entered.resolve(); await new Promise(resolve => { finish = resolve; }); }
          return { accepted: true, messageId: input.id };
        },
      });
      const daemon = spawn(process.execPath, ['--import', ${JSON.stringify(join(directory, 'runtime.mjs'))},
        ${JSON.stringify(new URL('../bin/daemon.mjs', import.meta.url).pathname)}, options.sessionDir], { stdio: ['ignore', 'inherit', 'inherit'] });
      const exited = once(daemon, 'exit');
      let nextPid, ack;
      try {
        await waitFor(() => existsSync(paths.daemon));
        const first = (await request(paths.daemon, { action: 'status' })).pid;
        assert.equal(first, daemon.pid);
        // A different executable path that still exists must not force retirement.
        await delay(100);
        assert.equal((await sendViaDaemon(paths, message, options)).accepted, true);
        assert.equal((await request(paths.daemon, { action: 'status' })).pid, first);
        let pending;
        if (${busy}) {
          pending = request(paths.daemon, { action: 'deliver', message: { ...message, id: 'busy' } });
          await entered.promise;
          // Keep the ACK connection half open after its response has arrived.
          ack = net.connect({ path: paths.daemon, allowHalfOpen: true });
          await once(ack, 'connect');
          ack.write(JSON.stringify({ action: 'status' }) + '\\n');
          await once(ack, 'data');
        }
        await rm(${JSON.stringify(fake)});
        if (${busy}) {
          await assert.rejects(request(paths.daemon, { action: 'deliver', message: { ...message, id: 'rejected' } }),
            { code: 'SERVER_CLOSED', uncertainDelivery: false, remote: true });
          await delay(100);
          assert.equal(daemon.exitCode, null);
          finish();
          assert.equal((await pending).accepted, true);
          await delay(100);
          assert.equal(daemon.exitCode, null, 'ACK connection must drain before retirement');
          ack.destroy();
        }
        await waitFor(() => daemon.exitCode !== null);
        assert.deepEqual(await exited, [0, null]);
        assert.equal((await sendViaDaemon(paths, { ...message, id: 'next' }, options)).accepted, true);
        nextPid = (await request(paths.daemon, { action: 'status' })).pid;
        assert.notEqual(nextPid, first);
        assert.deepEqual(calls, ${JSON.stringify(busy ? [message.id, 'busy', 'next'] : [message.id, 'next'])});
      } finally {
        finish?.();
        ack?.destroy();
        if (daemon.exitCode === null) daemon.kill('SIGTERM');
        await exited;
        if (!nextPid) { try { nextPid = (await request(paths.daemon, { action: 'status' })).pid; } catch {} }
        if (nextPid) { try { process.kill(nextPid, 'SIGTERM'); } catch {} }
        await recipient.close();
        await waitFor(() => !existsSync(paths.daemon));
      }
    `);
    const child = spawn(process.execPath, [join(directory, 'runner.mjs')], {
      env: { ...process.env, PI_AGENTS_STATE_DIR: join(directory, 'state') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
  });
}
