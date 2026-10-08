import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverRoots, findRoot } from '../src/roots/discovery.mjs';
import { sessionDir as resolveSessionDir } from '../src/roots/paths.mjs';

test('findRoot finds a root by its Pi Session file name or by scanning other Session files', async t => {
  const sessionDir = await mkdtemp('/tmp/pa-discovery-');
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  const directory = join(sessionDir, '--project--');
  await mkdir(directory);
  const session = id => JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp', timestamp: new Date().toISOString() }) + '\n';
  await writeFile(join(directory, '2026-10-06T00-00-00-000Z_named.jsonl'), session('named'));
  await writeFile(join(directory, 'renamed.jsonl'), session('other'));
  assert.equal((await findRoot(sessionDir, 'named'))?.sessionFile, join(directory, '2026-10-06T00-00-00-000Z_named.jsonl'));
  assert.equal((await findRoot(sessionDir, 'other'))?.sessionFile, join(directory, 'renamed.jsonl'));
  assert.equal(await findRoot(sessionDir, 'missing'), undefined);
});

test('a configured sessionDir holds roots directly, and its subagents/ holds children', async t => {
  const base = await mkdtemp('/tmp/pa-session-dir-');
  t.after(() => rm(base, { recursive: true, force: true }));
  const agentDir = join(base, 'agent');
  await mkdir(join(base, 'flat', 'subagents'), { recursive: true });
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: join(base, 'flat') }));
  const sessionDir = resolveSessionDir({ PI_CODING_AGENT_DIR: agentDir });
  assert.equal(sessionDir, join(base, 'flat'));
  const session = id => JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp', timestamp: new Date().toISOString() }) + '\n';
  await writeFile(join(sessionDir, 'root.jsonl'), session('root'));
  await writeFile(join(sessionDir, 'subagents', 'child.jsonl'), session('child'));
  assert.deepEqual((await discoverRoots(sessionDir)).map(root => root.id), ['root']);
});
