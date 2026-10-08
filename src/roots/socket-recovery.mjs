import { lstat, unlink } from 'node:fs/promises';
import { request } from './transport.mjs';

// Call only while holding the endpoint's lock. A missing registry
// entry or stale PID alone never authorizes removing a socket.
export async function recoverSocket(path) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!before.isSocket() || before.uid !== process.getuid()) throw new Error(`Refusing to replace a non-owned socket: ${path}`);
  try {
    await request(path, { action: 'status' }, { timeoutMs: 1000 });
    throw new Error(`Another runtime is responding at ${path}`);
  } catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error;
  }
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino) throw new Error(`Socket changed during recovery: ${path}`);
  await unlink(path);
}

