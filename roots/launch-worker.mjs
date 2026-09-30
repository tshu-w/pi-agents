import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from './transport.mjs';

export async function stopWorker(child, { graceMs = 1000 } = {}) {
  if (!child.pid) {
    // No process exists; a spawn error may already have fired or still be pending.
    if (child.listenerCount('error') === 0) child.once('error', () => {});
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

/** Starts a background Worker for an offline root Agent and waits until its runtime accepts messages. */
export async function launchWorker(root, { cli, extension, model, paths, signal, onSpawn }) {
  signal?.throwIfAborted();
  if (typeof root.cwd !== 'string' || !root.cwd.trim() || !isAbsolute(root.cwd)) {
    throw Object.assign(new Error(`Agent ${root.id} requires a nonempty absolute working directory; refusing cwd fallback.`), { code: 'INVALID_CWD' });
  }
  const args = [cli, '--mode', 'rpc', '--session', root.sessionFile, '-e', extension];
  if (model) args.push('--model', `${model.provider}/${model.modelId}`);
  const child = spawn(process.execPath, args, {
    cwd: root.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PI_AGENTS_BACKGROUND: '1',
      PI_AGENTS_BACKGROUND_PARENT: String(process.pid),
      PI_AGENTS_EXPECTED_SESSION: root.id,
      PI_AGENTS_EXPECTED_MODEL: model ? JSON.stringify(model) : '',
    },
  });
  let failure, ready = false;
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8192); });
  child.on('error', error => { failure = error; });
  child.on('exit', (code, exitSignal) => { failure ??= new Error(`Agent ${root.id} exited (${exitSignal ?? code}): ${stderr}`); });
  child.stdin.on('error', error => { failure ??= error; });
  function diagnostic(message) {
    if (ready) console.error(message);
    else failure = new Error(message);
  }
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'custom'].includes(event.method)) {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n');
      }
      diagnostic(`Agent ${root.id} requires interactive authorization. Open it interactively in ${root.cwd} first.`);
    }
    if (event?.type === 'extension_ui_request' && event.method === 'notify' && (ready || event.notifyType === 'error')) {
      diagnostic(`Agent ${root.id}: ${event.message}`);
    }
    if (event?.type === 'extension_error') diagnostic(`Agent ${root.id}: ${event.error}`);
  });
  try {
    onSpawn?.(child);
    for (;;) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      try {
        const status = await request(paths.worker(root.id), { action: 'status' }, { signal, timeoutMs: 1000 });
        signal?.throwIfAborted();
        if (failure) throw failure;
        if (status.id !== root.id || status.cwd !== root.cwd) throw new Error('Awakened Agent identity or cwd does not match its Session');
        if (status.availabilityError) throw new Error(status.availabilityError);
        if (status.ready) {
          if (model && (status.model?.provider !== model.provider || status.model?.modelId !== model.modelId)) {
            throw new Error(`Saved model ${model.provider}/${model.modelId} was not restored; refusing model fallback.`);
          }
          ready = true;
          return child;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      }
      await delay(50, undefined, { signal });
    }
  } catch (error) {
    await stopWorker(child);
    throw error;
  }
}
