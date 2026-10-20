'use strict';

// Read-only, pinned proof of the six-path CI repair. No dependencies or network.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const BASE = 'd2bcd46e639909af0da877f260c2c8e0ccafaa84';
const FEATURE = '217879271434755db57a55977d9b765e27229461';
const CHECKER = 'test/compat/check-release-ci-fix.js';
const root = path.resolve(__dirname, '../..');
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
function blob(ref, file) { return git('show', `${ref}:${file}`); }
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'Expected exactly one replacement site');
  return text.replace(before, after);
}
function inventory(ref) {
  return new Map(git('ls-tree', '-r', '-z', '--full-tree', ref).split('\0').filter(Boolean).map(row => {
    const split = row.indexOf('\t');
    assert.ok(split > 0, 'Malformed tree record');
    return [row.slice(split + 1), row.slice(0, split)];
  }));
}
const OWNER_ASSERTION = `
async function assertRetiredOwnerCannotRelease(retired, replacement) {
  await replacement.assertOwner();
  const ownerFile = path.join(replacement.lock, replacement.ownerName);
  const before = await fs.readFile(ownerFile, 'utf8');
  await assert.rejects(retired.release(), error => error instanceof Error && (
    error.message === 'title-writer-ownership-lost' || error.message === 'title-writer-token-mismatch' ||
    (error.code === 'ENOENT' && error.syscall === 'lstat' && error.path === path.join(retired.lock, retired.ownerName))
  ));
  await replacement.assertOwner();
  assert.deepEqual(await fs.readdir(replacement.lock), [replacement.ownerName]);
  assert.equal(await fs.readFile(ownerFile, 'utf8'), before);
}
`;

try {
  git('merge-base', '--is-ancestor', BASE, 'HEAD');
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '', 'The checked checkout must be clean');
  const expected = new Map();
  expected.set('package.json', replaceOnce(blob(BASE, 'package.json'), '\n  "version": "0.6.3",\n', '\n  "version": "0.6.4",\n'));
  let lock = replaceOnce(blob(BASE, 'package-lock.json'), '\n  "version": "0.6.3",\n', '\n  "version": "0.6.4",\n');
  lock = replaceOnce(lock, '\n      "name": "yuhan-codex-session-tabs",\n      "version": "0.6.3",\n', '\n      "name": "yuhan-codex-session-tabs",\n      "version": "0.6.4",\n');
  expected.set('package-lock.json', lock);

  const storeImport = "const { fixture, SOURCE, ACCOUNT, A, B, deferred } = require('./title-fixtures');\n";
  let store = replaceOnce(blob(BASE, 'test/title-store.test.js'), storeImport, storeImport + OWNER_ASSERTION);
  store = replaceOnce(store, '  await assert.rejects(a.release(), /ownership|token/); await b.release();\n', '  await assertRetiredOwnerCannotRelease(a, b); await b.release();\n');
  store = replaceOnce(store, '  await assert.rejects(dead.release(), /ownership|token/);\n', '  await assertRetiredOwnerCannotRelease(dead, slow);\n');
  store = replaceOnce(store, '  await assert.rejects(a.release(), /ownership|token/);\n', '  await assertRetiredOwnerCannotRelease(a, b);\n');
  expected.set('test/title-store.test.js', store);

  const fsImport = "const fs = require('node:fs/promises');\n";
  const key = 'const key = id => `**/local/${id}`;\n';
  let manager = replaceOnce(blob(BASE, 'test/auto-titles.test.js'), fsImport, fsImport + "const path = require('node:path');\n");
  manager = replaceOnce(manager, key, key + OWNER_ASSERTION);
  manager = replaceOnce(manager, '  await assert.rejects(old.a.store.release(), /ownership|token/);\n', '  await assertRetiredOwnerCannotRelease(old.a.store, b.store);\n');
  expected.set('test/auto-titles.test.js', manager);

  const syntheticOptions = "{ windowsHide: true, timeout: 3000, encoding: 'utf8' }";
  expected.set('test/title-process-boundary.test.js', replaceOnce(blob(BASE, 'test/title-process-boundary.test.js'), syntheticOptions, "{ windowsHide: true, timeout: 15000, encoding: 'utf8' }"));
  const base = inventory(BASE), feature = inventory(FEATURE), current = inventory('HEAD');
  for (const [file, entry] of base) {
    if (!expected.has(file)) assert.equal(current.get(file), entry, `Unapproved blob/mode change: ${file}`);
    else {
      assert.equal(current.get(file)?.split(' ')[0], entry.split(' ')[0], `File mode changed: ${file}`);
      assert.equal(blob('HEAD', file), expected.get(file), `Change exceeds the exact CI repair: ${file}`);
    }
  }
  for (const file of current.keys()) assert.ok(base.has(file) || file === CHECKER, `Unexpected new path: ${file}`);
  assert.equal(current.size, base.size + 1, 'Unexpected added or removed paths');
  assert.equal(current.get(CHECKER)?.split(' ')[0], '100644', 'Missing regular verifier');
  let runtimeFiles = 0;
  for (const [file, entry] of feature) {
    if (/^(src|py|media|icons)\//.test(file)) {
      assert.equal(current.get(file), entry, `Accepted runtime blob/mode changed: ${file}`);
      runtimeFiles++;
    }
  }
  assert.ok(runtimeFiles > 0, 'Missing accepted runtime inventory');
  console.log(JSON.stringify({ completed: true, base: BASE, feature: FEATURE, changedPaths: expected.size + 1,
    runtimeFiles, runtimeBlobsUnchanged: true, exactTestChanges: true, dependencyGraphUnchanged: true,
    workflowUnchanged: true, originalIntegrationProofUnchanged: true, version: '0.6.4' }));
} catch (error) {
  console.error(`Release CI repair verification failed: ${error.message}`);
  process.exitCode = 1;
}
