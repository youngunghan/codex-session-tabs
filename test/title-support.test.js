'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSupport, officialBinary } = require('../src/title-support');
const { fixture } = require('./title-fixtures');

test('remote, unknown Cursor API and native provider modes do not assume Sync support', async t => {
  const f = await fixture(t); const context = { globalStorageUri: { toString: () => 'file://synthetic/profile' } };
  const support = env => createSupport({ version: 'unknown', env }, context)();
  assert.equal((await support({ appName: 'Cursor', remoteName: 'ssh-remote' })).mode, 'blocked');
  assert.equal((await support({ appName: 'Cursor' })).mode, 'blocked');
  assert.equal((await support({ appName: 'Visual Studio Code' })).mode, 'native');
  const root = path.join(f.root, 'app'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'product.json'), '{}');
  assert.equal((await createSupport({ version: '1.128.0', env: { appName: 'Cursor', appRoot: root } }, context)()).mode, 'blocked');
});

test('platform-aware official CLI lookup contains resolved paths under the installed extension', async t => {
  const f = await fixture(t); const extension = path.join(f.root, 'extension');
  await fs.mkdir(path.join(extension, 'bin', 'windows-x86_64'), { recursive: true });
  const binary = path.join(extension, 'bin', 'windows-x86_64', 'codex.exe'); await fs.writeFile(binary, 'fake executable, never executed');
  assert.equal(await officialBinary({ extensionPath: extension }, 'win32', 'x64'), await fs.realpath(binary));
  await assert.rejects(officialBinary({ extensionPath: extension }, 'unknown', 'x64'), /unavailable/);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'codex.exe'), 'outside');
  await fs.unlink(binary); await fs.rmdir(path.dirname(binary)); await fs.symlink(outside, path.dirname(binary), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(officialBinary({ extensionPath: extension }, 'win32', 'x64'), /outside-extension/);
});
