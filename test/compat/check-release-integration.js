'use strict';

// Read-only proof of the two pinned inputs. No dependency installation or network.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FEATURE = '217879271434755db57a55977d9b765e27229461';
const UPSTREAM = '2db6f6f2bc5fea71903107a2cdbfe29e5c08575e';
const CHECKER = 'test/compat/check-release-integration.js';
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
    return [row.slice(split + 1), row.slice(0, split)]; // mode, object type and exact blob ID
  }));
}

try {
  const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  assert.deepEqual(parents.slice(1), [FEATURE, UPSTREAM], 'Expected the pinned two-parent integration commit');
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), '', 'The checked checkout must be clean');
  const feature = inventory(FEATURE), upstream = inventory(UPSTREAM), current = inventory('HEAD');
  const composed = new Set(['README.md', 'package.json', 'package-lock.json']);
  const workflow = '.github/workflows/release.yml';
  for (const [file, entry] of feature) {
    if (!composed.has(file)) assert.equal(current.get(file), entry, `Accepted feature blob/mode changed: ${file}`);
    else assert.equal(current.get(file)?.split(' ')[0], entry.split(' ')[0], `File mode changed: ${file}`);
  }
  assert.equal(current.get(workflow), upstream.get(workflow), 'Upstream workflow blob/mode changed');
  assert.equal(current.get(CHECKER)?.split(' ')[0], '100644', 'Missing regular verifier file');
  for (const file of current.keys()) {
    assert.ok(feature.has(file) || file === workflow || file === CHECKER, `Unexpected integrated path: ${file}`);
  }
  assert.equal(current.size, feature.size + 2, 'Unexpected added or removed paths');

  const expectedPackage = replaceOnce(blob(FEATURE, 'package.json'),
    '    "@vscode/vsce": "^4.0.0"\n', '    "@vscode/vsce": "^4.0.0",\n    "ovsx": "1.2.0"\n');
  assert.equal(blob('HEAD', 'package.json'), expectedPackage, 'Package changed beyond the pinned development dependency');
  let expectedLock = replaceOnce(blob(UPSTREAM, 'package-lock.json'), '\n  "version": "0.6.2",\n', '\n  "version": "0.6.3",\n');
  expectedLock = replaceOnce(expectedLock, '\n      "version": "0.6.2",\n', '\n      "version": "0.6.3",\n');
  assert.equal(blob('HEAD', 'package-lock.json'), expectedLock, 'Upstream lockfile changed beyond its two root versions');

  const publisher = 'Publisher: `youngunghan`. Extension ID: `youngunghan.yuhan-codex-session-tabs`.\n';
  const upstreamReadme = blob(UPSTREAM, 'README.md');
  const heading = '## Open VSX releases for Cursor\n\n';
  assert.equal(upstreamReadme.split(heading).length, 2, 'Missing unique upstream release section');
  const releaseSection = upstreamReadme.slice(upstreamReadme.indexOf(heading), upstreamReadme.indexOf(publisher));
  assert.ok(releaseSection.startsWith(heading) && releaseSection.endsWith('\n\n'), 'Malformed upstream release section');
  const expectedReadme = replaceOnce(blob(FEATURE, 'README.md'), publisher, releaseSection + publisher);
  assert.equal(blob('HEAD', 'README.md'), expectedReadme, 'README did not preserve both pinned inputs');
  console.log(JSON.stringify({ completed: true, feature: FEATURE, upstream: UPSTREAM,
    featureFilesPreserved: feature.size - composed.size, runtimeBlobsUnchanged: true,
    workflowExact: true, lockGraphExact: true, packageCompositionExact: true, readmeCompositionExact: true }));
} catch (error) {
  console.error(`Release integration verification failed: ${error.message}`);
  process.exitCode = 1;
}
