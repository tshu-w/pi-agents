import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { findRoot } from '../src/roots/discovery.mjs';

test('findRoot finds a root by its Pi Session file name or by scanning other Session files', async t => {
  const sessionRoot = await mkdtemp('/tmp/pa-discovery-');
  t.after(() => rm(sessionRoot, { recursive: true, force: true }));
  const directory = join(sessionRoot, '--project--');
  await mkdir(directory);
  const session = id => JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp', timestamp: new Date().toISOString() }) + '\n';
  await writeFile(join(directory, '2026-10-06T00-00-00-000Z_named.jsonl'), session('named'));
  await writeFile(join(directory, 'renamed.jsonl'), session('other'));
  assert.equal((await findRoot(sessionRoot, 'named'))?.sessionFile, join(directory, '2026-10-06T00-00-00-000Z_named.jsonl'));
  assert.equal((await findRoot(sessionRoot, 'other'))?.sessionFile, join(directory, 'renamed.jsonl'));
  assert.equal(await findRoot(sessionRoot, 'missing'), undefined);
});
