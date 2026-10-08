import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareDirectory } from '../roots/paths.mjs';
import { request } from '../roots/transport.mjs';

const RETRY = ['SERVER_CLOSED', 'CONNECTION_CLOSED', 'ECONNRESET', 'INVALID_FRAME'];

/**
 * Waits until the daemon answers, starting it when none runs.
 * @param {ReturnType<typeof import('../roots/paths.mjs').statePaths>} paths
 * @param {{ sessionDir: string, signal?: AbortSignal }} options
 */
export async function ensureDaemon(paths, { sessionDir, signal }) {
  await prepareDirectory(paths.runtime);
  for (;;) {
    try {
      return await request(paths.daemon, { action: 'status' }, { signal, timeoutMs: 1000 });
    } catch (error) {
      if (RETRY.includes(error.code)) {
        await delay(50, undefined, { signal });
        continue;
      }
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
    await prepareDirectory(paths.state);
    const log = await open(paths.daemonLog, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    let child;
    try {
      const info = await log.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Daemon log must be a private regular file');
      child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/daemon.mjs', import.meta.url)), sessionDir], {
        cwd: paths.runtime, detached: true, stdio: ['ignore', log.fd, log.fd],
      });
    } finally { await log.close(); }
    let launchError;
    child.on('error', error => { launchError = error; });
    child.once('exit', code => {
      if (code !== 0) launchError = new Error(`Daemon exited (${code}). See ${paths.daemonLog}`);
    });
    child.unref();
    for (;;) {
      signal?.throwIfAborted();
      if (launchError) throw launchError;
      try {
        return await request(paths.daemon, { action: 'status' }, { signal, timeoutMs: 1000 });
      } catch (failure) {
        if (!['ENOENT', 'ECONNREFUSED', ...RETRY].includes(failure.code)) throw failure;
        // Another daemon holds the lock; it answers once its socket is up.
        if (child.exitCode === 0) break;
      }
      await delay(50, undefined, { signal });
    }
  }
}

export async function sendViaDaemon(paths, message, { sessionDir, launch, signal, timeoutMs = 10000 }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    for (;;) {
      await ensureDaemon(paths, { sessionDir, signal: stop });
      try {
        return await request(paths.daemon, { action: 'deliver', message, launch }, { signal: stop, timeoutMs });
      } catch (error) {
        // Replay only when the transport guarantees the handler was not invoked.
        if (error.uncertainDelivery || !(['ENOENT', 'ECONNREFUSED'].includes(error.code)
          || (error.code === 'SERVER_CLOSED' && error.uncertainDelivery === false))) throw error;
        await delay(50, undefined, { signal: stop });
      }
    }
  } catch (error) {
    if (deadline.aborted && stop.reason === deadline.reason) {
      throw Object.assign(new Error('Acknowledgement timed out', { cause: error }), {
        code: 'ETIMEDOUT',
        ...(typeof error.uncertainDelivery === 'boolean' ? { uncertainDelivery: error.uncertainDelivery } : {}),
      });
    }
    throw error;
  }
}
