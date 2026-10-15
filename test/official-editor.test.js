'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openOfficialTab, EDITOR_ID, NEW_PANEL_PATH } = require('../src/official-editor');

async function fixture(t, bundle = `route = '${NEW_PANEL_PATH}'`) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-official-tab-'));
  const entry = path.join(root, 'extension.js');
  await fs.writeFile(entry, bundle);
  t.after(async () => { await fs.unlink(entry); await fs.rmdir(root); });
  const calls = [];
  const extension = { extensionPath: root, packageJSON: { version: 'test', main: './extension.js',
    contributes: { customEditors: [{ viewType: EDITOR_ID }] } } };
  const api = {
    extensions: { getExtension: () => extension }, ViewColumn: { Active: -1 },
    Uri: { from: fields => ({ ...fields, toString() { return `${this.scheme}://${this.authority}${this.path}#${this.fragment}`; } }) },
    commands: { executeCommand: async (...args) => { calls.push(args); } }
  };
  return { api, extension, calls, entry };
}

test('default path opens two distinct official editors without creating SDK panels or closing tabs', async t => {
  const { api, calls } = await fixture(t);
  const first = await openOfficialTab(api);
  const second = await openOfficialTab(api);
  assert.notEqual(first.toString(), second.toString());
  for (const [command, uri, viewType, options] of calls) {
    assert.equal(command, 'vscode.openWith');
    assert.equal(viewType, EDITOR_ID);
    assert.equal(uri.path, NEW_PANEL_PATH);
    assert.match(uri.fragment, /^codex-session-tabs-[0-9a-f-]+$/);
    assert.deepEqual(options, { viewColumn: -1, preview: false, preserveFocus: false });
  }
  assert.equal(calls.length, 2);
});

test('missing official extension reports the dependency instead of substituting the SDK interface', async t => {
  const { api, calls } = await fixture(t);
  api.extensions.getExtension = () => undefined;
  await assert.rejects(openOfficialTab(api), /Install the official Codex extension/);
  assert.equal(calls.length, 0);
});

test('unsupported official editor or route never opens a replacement interface', async t => {
  const { api, extension, calls } = await fixture(t, 'unsupported route');
  extension.packageJSON.contributes.customEditors = [];
  await assert.rejects(openOfficialTab(api), /does not register/);
  extension.packageJSON.contributes.customEditors = [{ viewType: EDITOR_ID }];
  await assert.rejects(openOfficialTab(api), /does not expose/);
  assert.equal(calls.length, 0);
});

test('entry point cannot escape the installed official extension directory', async t => {
  const { api, extension, calls } = await fixture(t);
  extension.packageJSON.main = '../outside.js';
  await assert.rejects(openOfficialTab(api), /outside its installation folder/);
  assert.equal(calls.length, 0);
});

test('a failed route check can be retried after the installed entry point is repaired', async t => {
  const { api, entry } = await fixture(t, 'old entry');
  await assert.rejects(openOfficialTab(api), /does not expose/);
  await fs.writeFile(entry, NEW_PANEL_PATH);
  await openOfficialTab(api);
});
