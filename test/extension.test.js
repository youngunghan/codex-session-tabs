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
    constructor(uri, viewType) {
      this.uri = uri.toString === Object.prototype.toString
        ? { ...uri, toString: () => `${uri.scheme}://${uri.authority}${uri.path}#${uri.fragment || ''}` }
        : uri;
      this.viewType = viewType;
    }
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

test('a history tab inherits the exact managed flow for repeated history switches', async () => {
  const makeTab = uri => ({ input: new fakeVscode.TabInputCustom(uri, 'chatgpt.conversationEditor'), isPreview: false });
  const first = makeTab(extension.newPanelUri());
  const historyOne = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/one' });
  const historyTwo = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/two' });
  const group = { tabs: [first], activeTab: first };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      activeTabGroup: group,
      close: async tab => { closed.push(tab); group.tabs = group.tabs.filter(item => item !== tab); }
    } }
  };
  const replacement = new extension.HistoryTabReplacement(api);
  group.tabs.push(historyOne);
  group.activeTab = historyOne;
  await replacement.onTabsChanged({ opened: [historyOne], closed: [] });
  assert.deepEqual(closed, [first]);

  group.tabs.push(historyTwo);
  group.activeTab = historyTwo;
  await replacement.onTabsChanged({ opened: [historyTwo], closed: [] });
  assert.deepEqual(closed, [first, historyOne],
    'the second saved-history selection should replace the exact history tab adopted by the first');
  assert.deepEqual(group.tabs, [historyTwo]);
});

test('two managed tabs retain independent history flows', async () => {
  const makeTab = uri => ({ input: new fakeVscode.TabInputCustom(uri, 'chatgpt.conversationEditor'), isPreview: false });
  const first = makeTab(extension.newPanelUri());
  const second = makeTab(extension.newPanelUri());
  const firstHistory = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/first' });
  const secondHistory = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/second' });
  const group = { tabs: [first, second], activeTab: first };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      activeTabGroup: group,
      close: async tab => { closed.push(tab); group.tabs = group.tabs.filter(item => item !== tab); }
    } }
  };
  const replacement = new extension.HistoryTabReplacement(api);
  group.tabs.push(firstHistory);
  group.activeTab = firstHistory;
  await replacement.onTabsChanged({ opened: [firstHistory], closed: [] });
  assert.deepEqual(closed, [first]);

  group.activeTab = second;
  await replacement.onTabsChanged({ opened: [], closed: [] });
  group.tabs.push(secondHistory);
  group.activeTab = secondHistory;
  await replacement.onTabsChanged({ opened: [secondHistory], closed: [] });
  assert.deepEqual(closed, [first, second]);
  assert.deepEqual(group.tabs, [firstHistory, secondHistory]);
});

test('a same-event official source disposal adopts history without closing twice', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/replaced' }, 'chatgpt.conversationEditor') };
  const group = { tabs: [], activeTab: history };
  let closeCalls = 0;
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      activeTabGroup: group,
      close: async () => { closeCalls++; }
    } }
  };
  const replacement = new extension.HistoryTabReplacement(api);
  replacement.previousActive = { group, tab: managed };
  group.tabs.push(history);
  await replacement.onTabsChanged({ opened: [history], closed: [managed] });
  assert.equal(closeCalls, 0, 'the already-disposed source must not be closed a second time');

  const nextHistory = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/next' }, 'chatgpt.conversationEditor') };
  group.tabs.push(nextHistory);
  group.activeTab = nextHistory;
  await replacement.onTabsChanged({ opened: [nextHistory], closed: [] });
  assert.equal(closeCalls, 1, 'lineage should transfer only to the exact history tab from the disposal event');
  assert.deepEqual(group.tabs, [history, nextHistory]);
});

test('a preview history tab opened in the background is not treated as user selection', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/background' }, 'chatgpt.conversationEditor'), isPreview: true };
  const group = { tabs: [managed], activeTab: managed, viewColumn: 1 };
  const closed = [];
  const promoted = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    ViewColumn: { Active: -1 },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      all: [group], activeTabGroup: group,
      close: async tab => { closed.push(tab); group.tabs = group.tabs.filter(item => item !== tab); }
    } },
    commands: { executeCommand: async (_command, uri, _editor, options) => {
      promoted.push({ uri, options });
      history.isPreview = false;
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  await manager.onTabsChanged({ opened: [history], closed: [] });
  assert.deepEqual(closed, [], 'opening a background history tab must not close the managed source');
  assert.deepEqual(promoted, [], 'pinning must wait until the history tab is independently active');

  group.activeTab = history;
  await manager.onTabsChanged({ opened: [], changed: [history], closed: [] });
  assert.deepEqual(closed, [managed]);
  assert.equal(promoted.length, 1, 'an active history tab should be pinned after the replacement decision');
});

test('history replacement aborts if the target stops being active during stabilization', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/transient' }, 'chatgpt.conversationEditor') };
  const other = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const group = { tabs: [managed, history, other], activeTab: history };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      all: [group], activeTabGroup: group,
      close: async tab => { closed.push(tab); }
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  const work = manager.onTabsChanged({ opened: [history], closed: [] });
  await new Promise(resolve => setTimeout(resolve, 20));
  group.activeTab = other;
  await manager.onTabsChanged({ opened: [], changed: [other], closed: [] });
  await work;
  assert.deepEqual(closed, [], 'the source must remain when the target is no longer active');
});

test('a failed preview pin leaves the managed source tab open', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/pin-failure' }, 'chatgpt.conversationEditor'), isPreview: true };
  const group = { tabs: [managed], activeTab: managed, viewColumn: 1 };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    ViewColumn: { Active: -1 },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      all: [group], activeTabGroup: group,
      close: async tab => { closed.push(tab); }
    } },
    commands: { executeCommand: async () => { throw new Error('simulated editor pin failure'); } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  group.activeTab = history;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await manager.onTabsChanged({ opened: [history], closed: [] });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(closed, [], 'the source must not close unless the target is pinned');
  assert.ok(group.tabs.includes(managed));
});

test('duplicate, pre-existing, or cross-group history tabs are not replacement targets', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const existing = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/already-open' }, 'chatgpt.conversationEditor') };
  const duplicate = { input: new fakeVscode.TabInputCustom(existing.input.uri, 'chatgpt.conversationEditor') };
  const group = { tabs: [managed], activeTab: managed };
  const otherGroup = { tabs: [existing], activeTab: existing };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      all: [group, otherGroup], activeTabGroup: group,
      close: async tab => { closed.push(tab); }
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  group.tabs.push(duplicate);
  group.activeTab = duplicate;
  await manager.onTabsChanged({ opened: [duplicate], closed: [] });
  assert.deepEqual(closed, [], 'a URI already open in another group must not be adopted');

  group.tabs = [managed];
  group.activeTab = managed;
  manager.syncActive();
  const distinctA = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/a' }, 'chatgpt.conversationEditor') };
  const distinctB = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/b' }, 'chatgpt.conversationEditor') };
  group.tabs.push(distinctA, distinctB);
  group.activeTab = distinctA;
  await manager.onTabsChanged({ opened: [distinctA, distinctB], closed: [] });
  assert.deepEqual(closed, [], 'a batch with multiple new histories is ambiguous and must be skipped');

  group.activeTab = managed;
  manager.syncActive();
  const crossGroup = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/cross-group' }, 'chatgpt.conversationEditor') };
  otherGroup.tabs.push(crossGroup);
  await manager.onTabsChanged({ opened: [crossGroup], closed: [] });
  assert.deepEqual(closed, [], 'a history tab in another group must not replace the managed source');
});

test('history replacement defaults on while a persisted false remains an opt-out', async () => {
  const manifest = require('../package.json');
  assert.equal(manifest.contributes.configuration.properties[
    'codexSessionTabs.replaceNewTabOnHistoryOpen'].default, true);

  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/old-false' }, 'chatgpt.conversationEditor') };
  const group = { tabs: [managed, history], activeTab: history };
  let closed = 0;
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => false ?? fallback }) },
    window: { tabGroups: { activeTabGroup: group, close: async () => { closed++; } } }
  };
  await new extension.HistoryTabReplacement(api).onTabsChanged({ opened: [history], closed: [] });
  assert.equal(closed, 0, 'an existing explicit false preference must continue to disable replacement');
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
  await replacement.onTabsChanged({ opened: [], closed: [history] });
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
