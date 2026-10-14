'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const fakeVscode = {
  extensions: { getExtension: () => undefined },
  Uri: { from: value => ({ ...value, toString: () => `${value.scheme}://${value.authority}${value.path}#${value.fragment}` }) },
  EventEmitter: class {
    constructor() { this.event = () => {}; this.fired = 0; }
    fire() { this.fired++; }
    dispose() {}
  },
  TabInputCustom: class {
    constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; }
  },
  window: { tabGroups: { all: [] } }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const extension = require('../src/extension');
const { openCodexTabs, isResumableUri, isManagedNewUri, rememberClosed } = require('../src/sessions');
Module._load = originalLoad;

test('new panels have unique document identities on the official route', () => {
  const first = extension.newPanelUri();
  const second = extension.newPanelUri();
  assert.equal(first.path, '/extension/panel/new');
  assert.equal(first.scheme, 'openai-codex');
  assert.equal(first.authority, 'route');
  assert.equal(isManagedNewUri(first), true);
  assert.notEqual(first.toString(), second.toString());
});

test('opening history replaces the active new tab created by this extension', async () => {
  const uri = (path, fragment = '') => ({ scheme: 'openai-codex', authority: 'route', path, fragment });
  const makeTab = value => ({ input: new fakeVscode.TabInputCustom(value, 'chatgpt.conversationEditor') });
  const newTab = makeTab(uri('/extension/panel/new', extension.newPanelUri().fragment));
  const history = makeTab(uri('/local/conversation-id'));
  const group = { tabs: [newTab], activeTab: newTab };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: () => true }) },
    window: { tabGroups: {
      activeTabGroup: group,
      close: async tab => { closed.push(tab); group.tabs = group.tabs.filter(item => item !== tab); }
    } }
  };
  const replacement = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  group.activeTab = history;
  await replacement.onTabsChanged({ opened: [history] });
  assert.deepEqual(closed, [newTab]);
  assert.deepEqual(group.tabs, [history]);
});

test('history also replaces the new tab when VS Code reports opening before activation', async () => {
  const newTab = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/conversation-id' },
    'chatgpt.conversationEditor') };
  const group = { tabs: [newTab], activeTab: newTab };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: () => true }) },
    window: { tabGroups: {
      activeTabGroup: group,
      close: async tab => { closed.push(tab); group.tabs = group.tabs.filter(item => item !== tab); }
    } }
  };
  const replacement = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  await replacement.onTabsChanged({ opened: [history] });
  assert.deepEqual(closed, []);
  group.activeTab = history;
  await replacement.onTabsChanged({ opened: [], changed: [history] });
  assert.deepEqual(closed, [newTab]);
});

test('preview history promotion preserves replacement state across reentrant tab events', async () => {
  const makeTab = uri => ({ input: new fakeVscode.TabInputCustom(uri, 'chatgpt.conversationEditor'), isPreview: false });
  const newTab = makeTab(extension.newPanelUri());
  const history = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/history-id' });
  history.isPreview = true;
  const group = { tabs: [newTab], activeTab: newTab, viewColumn: 1 };
  const closed = [];
  let promotions = 0;
  let replacement;
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    ViewColumn: { Active: -1 },
    workspace: { getConfiguration: () => ({ get: () => true }) },
    window: { tabGroups: {
      get all() { return [group]; },
      get activeTabGroup() { return group; },
      close: async tab => {
        closed.push(tab);
        group.tabs = group.tabs.filter(item => item !== tab);
      }
    } },
    commands: { executeCommand: async (command, uri, editor, options) => {
      promotions++;
      assert.equal(command, 'vscode.openWith');
      assert.equal(uri, history.input.uri);
      assert.equal(editor, 'chatgpt.conversationEditor');
      assert.equal(options.viewColumn, group.viewColumn);
      assert.equal(options.preview, false);
      assert.equal(options.preserveFocus, true);
      history.isPreview = false;
      await replacement.onTabsChanged({ opened: [], changed: [history], closed: [] });
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  replacement = manager;
  group.tabs.push(history);
  group.activeTab = history;
  await manager.onTabsChanged({ opened: [history], changed: [], closed: [] });
  assert.deepEqual(closed, [newTab]);
  assert.deepEqual(group.tabs, [history]);
  assert.equal(promotions, 1, 'the preview should be promoted once');
  assert.equal(manager.previousActive.tab, history, 'reentrant events should leave history as the active tab');
});

test('preview history promotion skips tabs without a current editor group', async () => {
  const makeTab = uri => ({ input: new fakeVscode.TabInputCustom(uri, 'chatgpt.conversationEditor'), isPreview: false });
  const history = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/history-id' });
  history.isPreview = true;
  const other = makeTab(extension.newPanelUri());
  const staleGroup = { tabs: [], activeTab: other, viewColumn: 1 };
  let opened = 0;
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    ViewColumn: { Active: -1 },
    window: { tabGroups: {
      all: [staleGroup], activeTabGroup: staleGroup
    } },
    commands: { executeCommand: async () => { opened++; } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  await manager.onTabsChanged({ opened: [history], changed: [], closed: [] });
  assert.equal(opened, 0, 'a stale or missing tab group must not fall back to the active group');
});

test('history navigation does not close an unrelated Codex tab', async () => {
  const newTab = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/extension/panel/new', fragment: '' },
    'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/conversation-id' },
    'chatgpt.conversationEditor') };
  const group = { tabs: [newTab], activeTab: newTab };
  let closed = false;
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    window: { tabGroups: { activeTabGroup: group, close: async () => { closed = true; } } }
  };
  const replacement = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  group.activeTab = history;
  await replacement.onTabsChanged({ opened: [history] });
  assert.equal(closed, false);
});

test('history replacement can be disabled and extension reopen is suppressed', async () => {
  const newTab = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const historyUri = { scheme: 'openai-codex', authority: 'route', path: '/local/conversation-id',
    toString: () => 'openai-codex://route/local/conversation-id' };
  const history = { input: new fakeVscode.TabInputCustom(historyUri, 'chatgpt.conversationEditor') };
  const group = { tabs: [newTab], activeTab: newTab };
  let closed = 0;
  let enabled = false;
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: () => enabled }) },
    window: { tabGroups: { activeTabGroup: group, close: async () => { closed++; } } }
  };
  const replacement = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  group.activeTab = history;
  await replacement.onTabsChanged({ opened: [history] });
  assert.equal(closed, 0);

  enabled = true;
  group.tabs = [newTab];
  group.activeTab = newTab;
  replacement.syncActive();
  replacement.suppress(historyUri.toString());
  group.tabs.push(history);
  group.activeTab = history;
  await replacement.onTabsChanged({ opened: [history] });
  assert.equal(closed, 0);
});

test('checks the installed Codex custom editor and route', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuhan-codex-'));
  try {
    await fs.writeFile(path.join(root, 'extension.js'), 'const route = "/old/path";');
    let main = 'extension.js';
    fakeVscode.extensions.getExtension = () => ({
      extensionPath: root,
      packageJSON: { main, contributes: { customEditors: [{ viewType: 'chatgpt.conversationEditor' }] } }
    });
    await assert.rejects(extension.checkCodexEditor(), /does not contain/);
    await fs.writeFile(path.join(root, 'extension.js'), 'const route = "/extension/panel/new";');
    await extension.checkCodexEditor();
    main = 'extension';
    await extension.checkCodexEditor();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session list includes only official Codex editor tabs in every group', () => {
  class TabInputCustom {
    constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; }
  }
  const uri = path => ({ scheme: 'openai-codex', authority: 'route', path, toString: () => `openai-codex://route${path}` });
  const groups = [
    { viewColumn: 1, tabs: [{ input: new TabInputCustom(uri('/extension/panel/new'), 'chatgpt.conversationEditor') }] },
    { viewColumn: 2, tabs: [
      { input: new TabInputCustom(uri('/local/abc'), 'chatgpt.conversationEditor') },
      { input: new TabInputCustom(uri('/other'), 'unrelated.editor') }
    ] }
  ];
  const tabs = openCodexTabs(groups, { TabInputCustom });
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs.map(item => item.group.viewColumn), [1, 2]);
});

test('recent list only keeps session URI entries and deduplicates them', () => {
  const uri = path => ({ scheme: 'openai-codex', authority: 'route', path });
  assert.equal(isResumableUri(uri('/local/123')), true);
  assert.equal(isResumableUri(uri('/remote/123')), true);
  assert.equal(isResumableUri(uri('/extension/panel/new')), false);
  const recent = rememberClosed([{ uri: 'one', label: 'Old' }], { uri: 'one', label: 'Renamed' });
  assert.deepEqual(recent, [{ uri: 'one', label: 'Renamed' }]);
});

test('sessions list updates when tabs open and only remembers resumable closed tabs', async () => {
  const data = new Map();
  const context = { workspaceState: {
    get: (key, fallback) => data.get(key) ?? fallback,
    update: async (key, value) => data.set(key, structuredClone(value))
  } };
  const tree = new extension.SessionTree(context);
  const makeTab = (path, label) => {
    const uri = { scheme: 'openai-codex', authority: 'route', path, toString: () => `openai-codex://route${path}` };
    return { label, input: new fakeVscode.TabInputCustom(uri, 'chatgpt.conversationEditor') };
  };
  const group = { viewColumn: 1, isActive: true, tabs: [] };
  fakeVscode.window.tabGroups.all = [group];
  const newTab = makeTab('/extension/panel/new', 'New chat');
  group.tabs.push(newTab);
  await tree.onTabsChanged({ opened: [newTab], closed: [], changed: [] });
  assert.equal(tree.getChildren()[0].label, 'Open tabs (1)');
  assert.equal(tree.onDidChangeTreeDataEmitter.fired, 1);

  const existing = makeTab('/local/123', 'Existing conversation');
  group.tabs.push(existing);
  await tree.onTabsChanged({ opened: [existing], closed: [], changed: [] });
  assert.equal(tree.getChildren()[0].label, 'Open tabs (2)');

  await tree.rename(newTab.input.uri.toString(), 'My draft');
  const moved = makeTab('/extension/panel/new', 'New chat');
  group.tabs = [existing, moved];
  await tree.onTabsChanged({ opened: [moved], closed: [newTab], changed: [] });
  assert.equal(tree.aliases[newTab.input.uri.toString()], 'My draft', 'moving a tab must preserve its list label');
  assert.equal(tree.getChildren()[1].label, 'Recently closed (0)');

  group.tabs = [];
  await tree.onTabsChanged({ opened: [], closed: [moved, existing], changed: [] });
  assert.equal(tree.getChildren()[1].label, 'Recently closed (1)');
  assert.deepEqual(data.get('codexSessionTabs.recent'), [{ uri: existing.input.uri.toString(), label: 'Existing conversation' }]);
  assert.equal(tree.aliases[newTab.input.uri.toString()], undefined, 'nonresumable closed-tab label should be discarded');
  tree.dispose();
});
