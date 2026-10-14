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

test('new-tab command uses the built-in sparkle icon in the editor toolbar and no status bar button', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const command = manifest.contributes.commands.find(item => item.command === 'codexSessionTabs.newTab');
  assert.equal(command.icon, '$(sparkle-filled)');
  assert.ok(manifest.contributes.menus['editor/title'].some(item => item.command === command.command));
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === command.command),
    'the optional Sessions view toolbar button remains available');
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.doesNotMatch(source, /createStatusBarItem/);
});

test('new panels have unique document identities on the official route', () => {
  const first = extension.newPanelUri();
  const second = extension.newPanelUri();
  assert.equal(first.path, '/extension/panel/new');
  assert.equal(first.scheme, 'openai-codex');
  assert.equal(first.authority, 'route');
  assert.equal(isManagedNewUri(first), true);
  assert.notEqual(first.toString(), second.toString());
});

test('tab-change events are processed sequentially while an earlier transition awaits', async () => {
  const manager = new extension.HistoryTabReplacement({ window: { tabGroups: { all: [] } } });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  manager.processTabsChanged = async observation => {
    const event = observation.opened[0];
    order.push(`start-${event}`);
    if (event === 'first') await firstGate;
    order.push(`end-${event}`);
  };

  const first = manager.onTabsChanged({ opened: ['first'], closed: [] });
  const second = manager.onTabsChanged({ opened: ['second'], closed: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['start-first'], 'the second event must wait for the in-flight tab transition');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start-first', 'end-first', 'start-second', 'end-second']);
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

test('Cursor-style wrapper churn reconciles exact URI tabs in the same view column', async () => {
  const sourceUri = extension.newPanelUri().toString();
  const historyUri = 'openai-codex://route/local/cursor-wrapper';
  const tab = uri => ({ input: new fakeVscode.TabInputCustom({
    scheme: 'openai-codex', authority: 'route', path: uri.includes('/new') ? '/extension/panel/new' : '/local/cursor-wrapper',
    fragment: uri.includes('/new') ? new URL(uri).hash.slice(1) : ''
  }, 'chatgpt.conversationEditor'), isPreview: false });
  const historyEvent = tab(historyUri);
  const closed = [];
  let historyOpened = false;
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      get all() { return [{ viewColumn: 1, tabs: historyOpened ? [tab(sourceUri), tab(historyUri)] : [tab(sourceUri)] }]; },
      get activeTabGroup() { return { viewColumn: 1, tabs: historyOpened ? [tab(sourceUri), tab(historyUri)] : [tab(sourceUri)], activeTab: tab(historyOpened ? historyUri : sourceUri) }; },
      close: async target => { closed.push(target.input.uri.toString()); }
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  historyOpened = true;
  await manager.onTabsChanged({ opened: [historyEvent], closed: [], changed: [] });
  assert.deepEqual(closed, [sourceUri], 'close resolves the unique current source by URI, not stale wrapper identity');
});

test('duplicate managed source URI in another group fails closed without closing either tab', async () => {
  const makeTab = uri => ({ input: new fakeVscode.TabInputCustom(uri, 'chatgpt.conversationEditor') });
  const source = makeTab(extension.newPanelUri());
  const duplicateSource = makeTab(source.input.uri);
  const history = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/ambiguous-source' });
  const sourceGroup = { viewColumn: 1, tabs: [source], activeTab: source };
  const otherGroup = { viewColumn: 2, tabs: [duplicateSource], activeTab: duplicateSource };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      all: [sourceGroup, otherGroup], activeTabGroup: sourceGroup,
      close: async tab => closed.push(tab)
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  sourceGroup.tabs.push(history);
  sourceGroup.activeTab = history;
  await manager.onTabsChanged({ opened: [history], closed: [], changed: [] });
  assert.deepEqual(closed, [], 'an ambiguous source URI must not identify a tab to close');
  assert.ok(sourceGroup.tabs.includes(source) && otherGroup.tabs.includes(duplicateSource));
});

test('rapid opened and activation events retain their event-time source lineage', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/rapid' }, 'chatgpt.conversationEditor') };
  const group = { tabs: [managed], activeTab: managed };
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      all: [group], activeTabGroup: group,
      close: async tab => { closed.push(tab); group.tabs = group.tabs.filter(item => item !== tab); }
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  const opened = manager.onTabsChanged({ opened: [history], changed: [], closed: [] });
  group.activeTab = history;
  const activated = manager.onTabsChanged({ opened: [], changed: [history], closed: [] });
  await Promise.all([opened, activated]);
  assert.deepEqual(closed, [managed]);
  assert.deepEqual(group.tabs, [history]);
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
  const group = { tabs: [managed], activeTab: history };
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
  group.tabs = [history];
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

test('fresh Cursor wrappers preserve source-disposal lineage without duplicating the active group', async () => {
  const source = new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor');
  const history = new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/cursor-disposed' }, 'chatgpt.conversationEditor');
  const nextHistory = new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/cursor-next' }, 'chatgpt.conversationEditor');
  let inputs = [source];
  let activeInput = source;
  const tab = input => ({ input });
  const group = () => ({ viewColumn: 1, tabs: inputs.map(tab), activeTab: tab(activeInput) });
  const closed = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      get all() { return [group()]; },
      get activeTabGroup() { return group(); },
      close: async target => {
        closed.push(target.input.uri.toString());
        inputs = inputs.filter(input => input.uri.toString() !== target.input.uri.toString());
      }
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  assert.deepEqual(manager.knownUris, [source.uri.toString()],
    'the same active group exposed through fresh wrappers must be counted once');

  inputs = [history];
  activeInput = history;
  await manager.onTabsChanged({ opened: [tab(history)], closed: [tab(source)], changed: [] });
  assert.deepEqual(closed, [], 'the source already disposed by the host must not be closed twice');

  inputs = [history, nextHistory];
  activeInput = nextHistory;
  await manager.onTabsChanged({ opened: [tab(nextHistory)], closed: [], changed: [] });
  assert.deepEqual(closed, [history.uri.toString()],
    'the URI lineage must transfer despite new Tab wrappers for the source and target');
});

test('a background preview is not selected until the user activates its history tab', async () => {
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
  const group = { tabs: [managed, other], activeTab: managed };
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
  group.tabs.push(history);
  group.activeTab = history;
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

test('a rejected tab close does not adopt the history URI as managed lineage', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/close-rejected' }, 'chatgpt.conversationEditor') };
  const group = { tabs: [managed], activeTab: managed };
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      activeTabGroup: group,
      close: async () => false
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  group.activeTab = history;
  await manager.onTabsChanged({ opened: [history], closed: [], changed: [] });
  assert.ok(group.tabs.includes(managed), 'a false close result should leave the source tab open');
  assert.equal(manager.managedUris.has(history.input.uri.toString()), false,
    'a history URI is adopted only if its originating source was closed');
});

test('an active custom editor is pinned with keepEditor before replacement', async () => {
  const managed = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const history = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/host-preview' }, 'chatgpt.conversationEditor'), isPreview: true };
  const group = { tabs: [managed], activeTab: managed, viewColumn: 1 };
  const closed = [];
  const commands = [];
  const api = {
    TabInputCustom: fakeVscode.TabInputCustom,
    ViewColumn: { Active: -1 },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      all: [group], activeTabGroup: group,
      close: async tab => { closed.push(tab); group.tabs = group.tabs.filter(item => item !== tab); }
    } },
    commands: { executeCommand: async command => {
      commands.push(command);
      if (command === 'workbench.action.keepEditor') history.isPreview = false;
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  group.tabs.push(history);
  group.activeTab = history;
  await manager.onTabsChanged({ opened: [history], changed: [], closed: [] });
  assert.deepEqual(commands, ['workbench.action.keepEditor']);
  assert.deepEqual(closed, [managed], 'the source closes only after the exact active history tab is pinned');
  assert.deepEqual(group.tabs, [history]);
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

  const defaultManaged = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const defaultHistory = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/unset-default' }, 'chatgpt.conversationEditor') };
  const defaultGroup = { tabs: [defaultManaged], activeTab: defaultManaged };
  const defaultClosed = [];
  const defaultApi = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { tabGroups: {
      activeTabGroup: defaultGroup,
      close: async tab => { defaultClosed.push(tab); defaultGroup.tabs = defaultGroup.tabs.filter(item => item !== tab); }
    } }
  };
  const defaultReplacement = new extension.HistoryTabReplacement(defaultApi);
  defaultGroup.tabs.push(defaultHistory);
  defaultGroup.activeTab = defaultHistory;
  await defaultReplacement.onTabsChanged({ opened: [defaultHistory], closed: [] });
  assert.deepEqual(defaultClosed, [defaultManaged], 'an unset preference should use the enabled default');

  const persistedManaged = { input: new fakeVscode.TabInputCustom(extension.newPanelUri(), 'chatgpt.conversationEditor') };
  const persistedHistory = { input: new fakeVscode.TabInputCustom(
    { scheme: 'openai-codex', authority: 'route', path: '/local/old-false' }, 'chatgpt.conversationEditor') };
  const persistedGroup = { tabs: [persistedManaged], activeTab: persistedManaged };
  let closed = 0;
  const persistedApi = {
    TabInputCustom: fakeVscode.TabInputCustom,
    workspace: { getConfiguration: () => ({ get: () => false }) },
    window: { tabGroups: { activeTabGroup: persistedGroup, close: async () => { closed++; } } }
  };
  const persistedReplacement = new extension.HistoryTabReplacement(persistedApi);
  persistedGroup.tabs.push(persistedHistory);
  persistedGroup.activeTab = persistedHistory;
  await persistedReplacement.onTabsChanged({ opened: [persistedHistory], closed: [] });
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
    commands: { executeCommand: async command => {
      promotions++;
      assert.equal(command, 'workbench.action.keepEditor');
      assert.equal(manager.active().tab, history, 'pinning must target the selected history tab');
      history.isPreview = false;
      void replacement.onTabsChanged({ opened: [], changed: [history], closed: [] });
    } }
  };
  const manager = new extension.HistoryTabReplacement(api);
  replacement = manager;
  group.tabs.push(history);
  group.activeTab = history;
  await manager.onTabsChanged({ opened: [history], changed: [], closed: [] });
  await manager.changeQueue;
  assert.deepEqual(closed, [newTab]);
  assert.deepEqual(group.tabs, [history]);
  assert.equal(promotions, 1, 'the preview should be promoted once');
  assert.equal(manager.previousActive.tab, history, 'reentrant events should leave history as the active tab');
});

test('preview history promotion skips an active target absent from all editor groups', async () => {
  const makeTab = uri => ({ input: new fakeVscode.TabInputCustom(uri, 'chatgpt.conversationEditor'), isPreview: false });
  const history = makeTab({ scheme: 'openai-codex', authority: 'route', path: '/local/history-id' });
  history.isPreview = true;
  const other = makeTab(extension.newPanelUri());
  const staleGroup = { tabs: [other], activeTab: history, viewColumn: 1 };
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
  assert.equal(opened, 0, 'an active preview absent from all groups must not fall back to the active group');
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
  assert.equal(isResumableUri({ ...uri('/remote/123'), query: 'hostId=remote-host' }), true,
    'route query metadata such as hostId does not make a saved conversation non-resumable');
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
