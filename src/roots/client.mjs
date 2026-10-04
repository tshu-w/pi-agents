import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareDirectory } from './registry.mjs';
import { request } from './transport.mjs';

export async function sendViaSupervisor(paths, message, { cli, sessionRoot, piIndex, extension, signal, timeoutMs = 10000 }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    await prepareDirectory(paths.directory);
    for (;;) {
      try {
        await request(paths.supervisor, { action: 'status' }, { signal: stop, timeoutMs: 1000 });
      } catch (error) {
        if (['WORKER_CLOSED', 'CONNECTION_CLOSED', 'ECONNRESET', 'INVALID_FRAME'].includes(error.code)) {
          await delay(50, undefined, { signal: stop });
          continue;
        }
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
        const log = await open(join(paths.directory, 'supervisor.log'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        let child;
        try {
          const info = await log.stat();
          if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Supervisor log must be a private regular file');
          child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/supervisor.mjs', import.meta.url)), cli, sessionRoot, piIndex, extension], {
            cwd: paths.directory, detached: true, stdio: ['ignore', log.fd, log.fd],
          });
        } finally { await log.close(); }
        let launchError;
        child.on('error', error => { launchError = error; });
        child.once('exit', code => {
          if (code !== 0) launchError = new Error(`Supervisor exited (${code}). See ${join(paths.directory, 'supervisor.log')}`);
        });
        child.unref();
        for (;;) {
          stop.throwIfAborted();
          if (launchError) throw launchError;
          try {
            await request(paths.supervisor, { action: 'status' }, { signal: stop, timeoutMs: 1000 });
            break;
          } catch (failure) {
            if (!['ENOENT', 'ECONNREFUSED', 'WORKER_CLOSED', 'CONNECTION_CLOSED', 'ECONNRESET', 'INVALID_FRAME'].includes(failure.code)) throw failure;
            if (child.exitCode === 0) break;
          }
          await delay(50, undefined, { signal: stop });
        }
      }
      try {
        return await request(paths.supervisor, { action: 'deliver', message }, { signal: stop, timeoutMs });
      } catch (error) {
        // Replay only when the transport guarantees the handler was not invoked.
        if (error.uncertainDelivery || !(['ENOENT', 'ECONNREFUSED'].includes(error.code)
          || (error.code === 'WORKER_CLOSED' && error.uncertainDelivery === false))) throw error;
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
