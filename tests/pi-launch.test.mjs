import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { executableOnPath, piLaunch } from '../src/pi.mjs';

test('launches keep matching PATH entries and recover after their old targets disappear', t => {
  const dir = mkdtempSync('/tmp/pa-launch-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const env = { PATH: bin };
  const install = version => {
    const root = join(dir, version);
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
    for (const name of ['node', 'wrapper', 'cli.js']) writeFileSync(join(root, name), '', { mode: 0o755 });
    return root;
  };
  const old = install('old'), next = install('next');
  symlinkSync(join(old, 'node'), join(bin, 'node'));
  symlinkSync(join(old, 'wrapper'), join(bin, 'pi'));
  const cli = join(old, 'cli.js');
  assert.equal(executableOnPath('node', join(old, 'node'), env), join(bin, 'node'));
  assert.deepEqual(piLaunch(cli, ['-e', 'extension'], env), { command: join(bin, 'pi'), args: ['-e', 'extension'] });
  assert.equal(executableOnPath('pi', join(next, 'cli.js'), env), join(next, 'cli.js'), 'do not switch an existing installation');
  rmSync(join(bin, 'pi'));
  symlinkSync(cli, join(bin, 'pi'));
  assert.deepEqual(piLaunch(cli, [], env), { command: process.execPath, args: [join(bin, 'pi')] }, 'an npm link keeps the current Node when PATH names another one');
  for (const [name, target] of [['node', 'node'], ['pi', 'wrapper']]) {
    rmSync(join(bin, name));
    symlinkSync(join(next, target), join(bin, name));
  }
  rmSync(old, { recursive: true });
  assert.equal(executableOnPath('node', join(old, 'node'), env), join(bin, 'node'));
  assert.deepEqual(piLaunch(cli, [], env), { command: join(bin, 'pi'), args: [] });
  assert.equal(executableOnPath('pi', cli, { PATH: '' }), cli);
});
