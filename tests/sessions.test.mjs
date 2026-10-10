import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { statePaths } from '../src/roots/paths.mjs';
import { createSessions } from '../src/daemon/sessions.mjs';

test('a turn that ends while no terminal is attached needs attention until one attaches, across daemon restarts', async t => {
  const base = await mkdtemp('/tmp/pa-seen-');
  t.after(() => rm(base, { recursive: true, force: true }));
  const paths = statePaths({ PI_AGENTS_STATE_DIR: base });
  const sessionDir = join(base, 'sessions');
  await mkdir(join(sessionDir, 'project'), { recursive: true });
  const session = id => JSON.stringify({ type: 'session', version: 3, id, cwd: base, timestamp: new Date().toISOString() }) + '\n';
  for (const id of ['a', 'b', 'c']) await writeFile(join(sessionDir, 'project', `${id}.jsonl`), session(id));
  // A Session opened from outside the session directory, as with `pi --session <path>`.
  const outside = join(base, 'd.jsonl');
  await writeFile(outside, session('d'));
  let sessions = await createSessions(paths, sessionDir);
  const attention = async () => Object.fromEntries((await sessions.list()).map(row => [row.id, row.attention]));
  // Sessions from before the daemon are not listed.
  assert.deepEqual(await attention(), {});

  sessions.update({ id: 'a', attached: true, turn: { at: 1, failed: false } });
  sessions.update({ id: 'b', attached: false, turn: { at: 1, failed: true } });
  sessions.update({ id: 'c', attached: false, turn: { at: 1, failed: false } });
  sessions.end('c');
  sessions.update({ id: 'd', sessionFile: outside, attached: false, turn: { at: 1, failed: false } });
  sessions.end('d');
  assert.deepEqual(await attention(), { a: undefined, b: 'failed', c: 'done', d: 'done' });

  await sessions.saved();
  sessions = await createSessions(paths, sessionDir);
  sessions.update({ id: 'b', attached: true });
  // A Session that stops without saying so has failed.
  sessions.update({ id: 'a', attached: false });
  sessions.end('a', { abnormal: true });
  assert.deepEqual(await attention(), { a: 'failed', b: undefined, c: 'done', d: 'done' });
  // Removing a Session from the list also clears its unseen turn.
  sessions.hide('c');
  assert.deepEqual(await attention(), { a: 'failed', b: undefined, d: 'done' });
  // A previewed Session's turn is seen.
  sessions.see('d');
  assert.deepEqual(await attention(), { a: 'failed', b: undefined, d: undefined });
  await sessions.saved();
});
