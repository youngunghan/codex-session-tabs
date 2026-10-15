'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openOfficialTab, retainOfficialHistoryTabs, EDITOR_ID, NEW_PANEL_PATH } = require('../src/official-editor');

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

function historyFixture() {
  let onTabs;
  let listenerDisposed = false;
  const calls = [];
  class TabInputCustom {
    constructor(path, fragment = '') {
      this.uri = { scheme: 'openai-codex', authority: 'route', path, fragment };
      this.viewType = EDITOR_ID;
    }
  }
  const group = { viewColumn: 2, tabs: [] };
  const api = {
    TabInputCustom,
    window: { tabGroups: { all: [group], onDidChangeTabs(callback) {
      onTabs = callback; return { dispose() { listenerDisposed = true; } };
    } } },
    commands: { async executeCommand(...args) {
      calls.push(args);
      const tab = group.tabs.find(item => item.input.uri === args[1]);
      if (tab) {
        tab.isPreview = false;
        onTabs({ opened: [], changed: [tab], closed: [] });
      }
    } }
  };
  const tab = (path, preview = true) => ({ input: new TabInputCustom(path), isPreview: preview });
  const emit = (opened = [], changed = [], closed = []) => onTabs({ opened, changed, closed });
  return { api, group, tab, emit, calls, listenerDisposed: () => listenerDisposed };
}

test('history previews become permanent without reopening or activating their editor', () => {
  const f = historyFixture();
  const retention = retainOfficialHistoryTabs(f.api);
  const first = f.tab('/local/0199ab00-0000-7000-8000-000000000001');
  f.group.tabs.push(first);
  f.emit([first]);
  assert.equal(first.isPreview, false);
  const second = f.tab('/remote/0199ab00-0000-7000-8000-000000000002');
  f.group.tabs.push(second);
  f.emit([second]);
  assert.equal(second.isPreview, false);
  assert.equal(f.group.tabs.length, 2);
  for (const [command, uri, ...rest] of f.calls) {
    assert.equal(command, 'workbench.action.keepEditor');
    assert.ok([first.input.uri, second.input.uri].includes(uri));
    assert.deepEqual(rest, [], 'must not reopen, activate or select an editor group');
  }
  retention.dispose();
  assert.equal(f.listenerDisposed(), true);
});

test('retention pins existing history previews but ignores new routes, other editors and closed tabs', () => {
  const f = historyFixture();
  const existing = f.tab('/local/0199ab00-0000-7000-8000-000000000003');
  const newRoute = f.tab(NEW_PANEL_PATH);
  const pinned = f.tab('/local/0199ab00-0000-7000-8000-000000000004', false);
  const text = { input: { uri: existing.input.uri }, isPreview: true };
  const otherEditor = f.tab('/local/0199ab00-0000-7000-8000-000000000005');
  otherEditor.input.viewType = 'other.editor';
  const otherScheme = f.tab('/local/0199ab00-0000-7000-8000-000000000006');
  otherScheme.input.uri.scheme = 'file';
  f.group.tabs.push(existing, newRoute, pinned, text, otherEditor, otherScheme);
  const retention = retainOfficialHistoryTabs(f.api);
  assert.equal(f.calls.length, 1);
  const closed = f.tab('/local/0199ab00-0000-7000-8000-000000000007');
  f.emit([], [closed], [closed]);
  assert.equal(f.calls.length, 1, 'stale/closed tabs must never be recreated');
  retention.dispose();
  f.emit([newRoute]);
  assert.equal(f.calls.length, 1);
});

test('retention deduplicates pending changes and reports command failures without retry loops', async () => {
  const f = historyFixture();
  let reject;
  f.api.commands.executeCommand = (...args) => {
    f.calls.push(args);
    return new Promise((_resolve, fail) => { reject = fail; });
  };
  const errors = [];
  const retention = retainOfficialHistoryTabs(f.api, (...args) => errors.push(args));
  const first = f.tab('/local/0199ab00-0000-7000-8000-000000000001');
  f.group.tabs.push(first);
  f.emit([first]);
  f.emit([], [first]);
  assert.equal(f.calls.length, 1);
  reject(new Error('editor unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(f.calls.length, 1);
  f.emit([], [first]);
  assert.equal(f.calls.length, 1, 'a failed keep must not retry on every label or focus change');
  retention.dispose();
});

test('a delayed keep never reopens a closed editor or uses a captured group position', async () => {
  const f = historyFixture();
  let finish;
  f.api.commands.executeCommand = (...args) => {
    f.calls.push(args);
    return new Promise(resolve => { finish = resolve; });
  };
  const retention = retainOfficialHistoryTabs(f.api);
  const first = f.tab('/local/0199ab00-0000-7000-8000-000000000001');
  f.group.tabs.push(first);
  f.emit([first]);
  f.group.tabs.splice(0);
  f.group.viewColumn = 1;
  f.emit([], [], [first]);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.group.tabs.length, 0);
  assert.deepEqual(f.calls, [['workbench.action.keepEditor', first.input.uri]]);
  retention.dispose();
});

test('a successful command with stale preview state is attempted only once and non-thread routes are ignored', async () => {
  const f = historyFixture();
  f.api.commands.executeCommand = async (...args) => { f.calls.push(args); };
  const retention = retainOfficialHistoryTabs(f.api);
  const first = f.tab('/local/0199ab00-0000-7000-8000-000000000001');
  const settings = f.tab('/local/settings');
  f.group.tabs.push(first, settings);
  f.emit([first, settings]);
  await new Promise(resolve => setImmediate(resolve));
  f.emit([], [first, settings]);
  assert.equal(f.calls.length, 1);
  retention.dispose();
});
