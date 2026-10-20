'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWritableFinalizer } = require('./writable-files');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'codex-stage-a-writable-test-'));
  const identity = fs.lstatSync(directory);
  const readonly = [];
  const root = path.join(directory, 'generated');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  t.after(() => {
    // Delete only this test's verified mkdtemp fixture, never a caller path.
    const absolute = path.resolve(directory);
    const stat = fs.lstatSync(absolute);
    assert.equal(path.dirname(absolute), parent);
    assert.ok(path.basename(absolute).startsWith('codex-stage-a-writable-test-'));
    assert.ok(!stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino);
    assert.equal(fs.realpathSync(absolute), absolute);
    for (const file of readonly) fs.chmodSync(file, 0o600);
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return { root, outside, restoreReadonly: file => readonly.push(file) };
}

test('clears readonly only on nested generated regular files and retains contents', t => {
  const { root } = fixture(t);
  const pack = path.join(root, '.codex', '.tmp', 'plugins-clone-probe', '.git', 'objects', 'pack');
  fs.mkdirSync(pack, { recursive: true });
  const file = path.join(pack, 'pack-probe.idx');
  fs.writeFileSync(file, 'synthetic pack');
  fs.chmodSync(file, 0o444);
  assert.equal(fs.statSync(file).mode & 0o200, 0);
  const result = createWritableFinalizer(root)();
  assert.equal(result.changed, 1);
  assert.ok(fs.statSync(file).mode & 0o200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic pack');
  assert.equal(createWritableFinalizer(root)().changed, 0);
});

test('skips a directory junction or symlink without touching its outside target', t => {
  const { root, outside, restoreReadonly } = fixture(t);
  const file = path.join(outside, 'outside.txt');
  fs.writeFileSync(file, 'outside');
  fs.chmodSync(file, 0o444);
  restoreReadonly(file);
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.statSync(file).mode;
  const result = createWritableFinalizer(root)();
  assert.equal(result.changed, 0);
  assert.equal(result.skipped[0].reason, 'symlink-or-junction');
  assert.equal(fs.statSync(file).mode, before);
});

test('skips hardlinked regular files so outside file attributes are preserved', t => {
  const { root, outside, restoreReadonly } = fixture(t);
  const file = path.join(outside, 'shared.pack');
  fs.writeFileSync(file, 'shared');
  fs.linkSync(file, path.join(root, 'linked.pack'));
  fs.chmodSync(file, 0o444);
  restoreReadonly(file);
  const before = fs.statSync(file).mode;
  const result = createWritableFinalizer(root)();
  assert.equal(result.changed, 0);
  assert.equal(result.skipped[0].reason, 'multiple-hardlinks');
  assert.equal(fs.statSync(file).mode, before);
});

test('refuses a replaced root directory', t => {
  const { root } = fixture(t);
  const finalize = createWritableFinalizer(root);
  fs.renameSync(root, `${root}-original`);
  fs.mkdirSync(root);
  assert.throws(finalize, /root identity changed/);
});

test('refuses a root replaced with a junction or symlink', t => {
  const { root, outside } = fixture(t);
  const finalize = createWritableFinalizer(root);
  fs.renameSync(root, `${root}-original`);
  fs.symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(finalize, /root identity changed/);
});
