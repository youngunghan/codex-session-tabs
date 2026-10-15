'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { validateMessage } = require('../src/protocol');

const THREAD_A = '0199ab00-0000-7000-8000-000000000001';
const THREAD_B = '0199ab00-0000-7000-8000-000000000002';

function loadExtension() {
  const api = {
    Uri: { joinPath: (...parts) => ({ fsPath: parts.map(p => p.fsPath || p).join('/'), toString() { return this.fsPath; } }) },
    env: { remoteName: undefined },
    ViewColumn: { Active: 1 },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace', toString: () => 'file:///workspace' } }], isTrusted: true,
      getConfiguration: () => ({ get: () => '' }) },
    window: { showWarningMessage: async () => 'Open read only',
      withProgress: async (_options, callback) => callback({ report() {} }) },
    ProgressLocation: { Notification: 1 }
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return api;
    return original.call(this, request, parent, isMain);
  };
  let extension;
  try {
    for (const file of ['../src/extension', '../src/webview']) delete require.cache[require.resolve(file)];
    extension = require('../src/extension');
  } finally { Module._load = original; }
  return { api, extension };
}

function fixture() {
  const { api, extension } = loadExtension();
  const calls = [];
  const runtime = {
    ready: true,
    check: async () => true,
    run(request, onEvent) {
      calls.push(request);
      const events = request.op === 'send'
        ? [...(!request.threadId ? [{ kind: 'thread', threadId: THREAD_A }] : []),
          { kind: 'turn', turnId: 'turn-1' }, { kind: 'delta', text: 'Hello', itemId: 'item-1' },
          { kind: 'item', text: 'Hello', role: 'assistant', itemId: 'item-1' },
          { kind: 'completed', status: 'completed' }]
        : request.op === 'list'
          ? [{ kind: 'list', threads: [{ id: THREAD_B, name: 'Earlier', cwd: '/workspace', preview: 'old' }], nextCursor: null }]
          : request.op === 'load'
            ? [{ kind: 'loadedChunk', messages: [{ role: 'user', text: 'old', continuation: false },
              { role: 'assistant', text: 'answer', continuation: false }] },
            { kind: 'loaded', thread: { id: request.threadId, name: 'Earlier', preview: 'old' } }]
            : [{ kind: 'renamed', threadId: request.threadId, name: request.name }];
      const promise = Promise.resolve().then(() => { events.forEach(onEvent); });
      return { promise, stop() {}, kill() {} };
    }
  };
  const stored = {};
  const context = { globalStorageUri: { fsPath: '/storage', toString: () => 'file:///storage' },
    workspaceState: { get: (key, fallback) => stored[key] || fallback,
      update: async (key, value) => { stored[key] = structuredClone(value); } },
    extensionUri: { fsPath: '/extension' }, extensionPath: '/extension', subscriptions: [] };
  const tabs = new extension.ChatTabs(context, runtime);
  const posted = [];
  const panel = { title: '', revealCalled: false, reveal() { this.revealCalled = true; },
    webview: { asWebviewUri: uri => uri.fsPath, cspSource: 'vscode-resource:',
      postMessage: message => { posted.push(message); }, onDidReceiveMessage() {} }, onDidDispose() {} };
  tabs.attach(panel);
  const state = [...tabs.panels][0];
  return { tabs, state, panel, calls, posted, api, runtime, context, stored };
}

test('new Codex command and editor tab use packaged light and dark icons', async () => {
  const { panel } = fixture();
  const command = require('../package.json').contributes.commands.find(item => item.command === 'codexSessionTabs.newTab');
  assert.deepEqual(command.icon, { light: 'icons/codex-light.svg', dark: 'icons/codex-dark.svg' });
  for (const theme of ['light', 'dark']) {
    const iconFile = path.join(__dirname, '..', command.icon[theme]);
    assert.equal(panel.iconPath[theme].fsPath, `/extension/${command.icon[theme]}`);
    assert.match(await fs.readFile(iconFile, 'utf8'), /<svg[^>]+viewBox="0 0 16 16"/);
  }
});

test('webview requests reject malformed IDs, dangerous modes, and empty messages', () => {
  assert.ok(!validateMessage({ type: 'select', threadId: '../session' }), 'invalid thread ID must be rejected');
  assert.equal(validateMessage({ type: 'mode', mode: 'full_access' }), undefined);
  assert.equal(validateMessage({ type: 'send', text: '   ' }), undefined);
  assert.deepEqual(validateMessage({ type: 'select', threadId: THREAD_A }), { type: 'select', threadId: THREAD_A });
  assert.deepEqual(validateMessage({ type: 'send', text: 'edit my project' }), { type: 'send', text: 'edit my project' });
});

test('first send keeps the emitted thread ID and subsequent send resumes it', async () => {
  const { tabs, state, panel, calls, posted } = fixture();
  assert.equal(state.threadId, null);
  await tabs.handle(state, { type: 'send', text: 'Hello Codex' });
  assert.equal(state.threadId, THREAD_A);
  assert.equal(panel.title, 'Hello Codex');
  assert.equal(calls[0].threadId, null);
  assert.equal(calls[0].mode, 'read_only');
  assert.ok(posted.some(event => event.type === 'thread' && event.threadId === THREAD_A));
  assert.ok(posted.some(event => event.type === 'delta' && event.text === 'Hello'));
  const kinds = posted.map(event => event.type);
  assert.ok(kinds.indexOf('thread') < kinds.indexOf('user'));
  assert.ok(kinds.indexOf('user') < kinds.indexOf('delta'));
  await tabs.handle(state, { type: 'send', text: 'Continue' });
  assert.equal(calls[1].threadId, THREAD_A);
  assert.equal(calls[1].cwd, '/workspace');
});

test('history switch and rename update the real thread and current editor title', async () => {
  const { tabs, state, panel, calls, posted } = fixture();
  await tabs.handle(state, { type: 'history' });
  await tabs.handle(state, { type: 'select', threadId: THREAD_B });
  assert.equal(state.threadId, THREAD_B);
  assert.equal(panel.title, 'Earlier');
  assert.ok(posted.some(event => event.type === 'loadedChunk' && event.messages.length === 2));
  assert.ok(posted.findIndex(event => event.type === 'loaded') < posted.findIndex(event => event.type === 'loadedChunk'),
    'the webview must clear the old conversation before appending history chunks');
  await tabs.handle(state, { type: 'rename', name: 'Important work' });
  assert.equal(panel.title, 'Important work');
  assert.ok(calls.some(call => call.op === 'rename' && call.threadId === THREAD_B && call.name === 'Important work'));
});

test('switching history threads resets write permission before the next send', async () => {
  const { tabs, state, calls, posted, api } = fixture();
  api.window.showWarningMessage = async () => 'Allow workspace writes';
  await tabs.handle(state, { type: 'mode', mode: 'workspace_write' });
  assert.equal(state.mode, 'workspace_write');
  await tabs.handle(state, { type: 'history' });
  await tabs.handle(state, { type: 'select', threadId: THREAD_B });
  assert.equal(state.mode, 'read_only');
  assert.ok(posted.some(event => event.type === 'mode' && event.mode === 'read_only'));
  await tabs.handle(state, { type: 'send', text: 'continue selected thread' });
  assert.equal(calls.findLast(call => call.op === 'send').mode, 'read_only');
});

test('history pagination passes the SDK cursor and appends the next page', async () => {
  const { tabs, state, calls, posted } = fixture();
  await tabs.handle(state, { type: 'history' });
  await tabs.handle(state, { type: 'historyMore', cursor: 'opaque-next-page' });
  assert.equal(calls[1].cursor, 'opaque-next-page');
  assert.ok(posted.some(event => event.type === 'history' && event.append === true));
});

test('selecting a thread already owned by another tab focuses it without another SDK resume', async () => {
  const { tabs, state, panel, calls } = fixture();
  tabs.setThread(state, THREAD_A, 'One');
  const other = { panel: { revealCalled: false, reveal() { this.revealCalled = true; } } };
  tabs.owners.set(THREAD_B, other);
  await tabs.handle(state, { type: 'history' });
  await tabs.handle(state, { type: 'select', threadId: THREAD_B });
  assert.equal(other.panel.revealCalled, true);
  assert.equal(panel.title, 'One');
  assert.equal(calls.filter(call => call.op === 'load').length, 0);
});

test('busy tab refuses a second operation without changing its thread', async () => {
  const { tabs, state, calls } = fixture();
  state.busy = true;
  await assert.rejects(tabs.handle(state, { type: 'send', text: 'another' }), /busy/);
  assert.equal(state.threadId, null);
  assert.equal(calls.length, 0);
});

test('a failed first turn retains the SDK thread ID and restores the unsent draft', async () => {
  const { tabs, state, posted, runtime } = fixture();
  runtime.run = (_request, onEvent) => ({
    promise: Promise.resolve().then(() => {
      onEvent({ kind: 'thread', threadId: THREAD_A });
      throw new Error('turn/start failed');
    }), stop() {}
  });
  await assert.rejects(tabs.handle(state, { type: 'send', text: 'Keep this text' }), /turn\/start failed/);
  assert.equal(state.threadId, THREAD_A);
  assert.ok(posted.some(event => event.type === 'restoreDraft' && event.text === 'Keep this text'));
});

test('stream crash after turn start retains the draft and flags uncertain outcome', async () => {
  const { tabs, state, posted, runtime } = fixture();
  runtime.run = (_request, onEvent) => ({
    promise: Promise.resolve().then(() => {
      onEvent({ kind: 'thread', threadId: THREAD_A });
      onEvent({ kind: 'turn', turnId: 'turn-1' });
      throw new Error('transport closed');
    }), stop() {}
  });
  let failure;
  try { await tabs.handle(state, { type: 'send', text: 'Keep after start' }); }
  catch (error) { failure = error; tabs.error(state, error); }
  assert.equal(state.threadId, THREAD_A);
  assert.ok(posted.some(event => event.type === 'restoreDraft' && event.text === 'Keep after start'));
  assert.ok(posted.some(event => event.type === 'status' && /outcome unknown/.test(event.text)));
  assert.equal(failure.outcomeUnknown, true);
});

test('write mode needs explicit confirmation and stays scoped to its existing tab', async () => {
  const { tabs, state, api, calls } = fixture();
  api.window.showWarningMessage = async () => 'Allow workspace writes';
  await tabs.handle(state, { type: 'mode', mode: 'workspace_write' });
  assert.equal(state.mode, 'workspace_write');
  await tabs.handle(state, { type: 'send', text: 'Edit a file' });
  assert.equal(calls[0].mode, 'workspace_write');
  const panel = { title: '', webview: { asWebviewUri: uri => uri.fsPath, cspSource: 'vscode-resource:',
    postMessage() {}, onDidReceiveMessage() {} }, onDidDispose() {} };
  tabs.attach(panel);
  const newTab = [...tabs.panels].find(item => item !== state);
  assert.equal(newTab.mode, 'read_only');
  assert.equal(state.mode, 'workspace_write');
  api.workspace.isTrusted = false;
  await assert.rejects(tabs.handle(state, { type: 'mode', mode: 'workspace_write' }), /trust this tab’s workspace/);
});

test('write approval stays on the original folder after multi-root reorder and expires on trust loss', async () => {
  const { tabs, state, api, calls, posted } = fixture();
  const original = api.workspace.workspaceFolders[0];
  const other = { uri: { fsPath: '/other', toString: () => 'file:///other' } };
  api.window.showWarningMessage = async () => 'Allow workspace writes';
  await tabs.handle(state, { type: 'mode', mode: 'workspace_write' });
  api.workspace.workspaceFolders = [other, original];
  await tabs.handle(state, { type: 'send', text: 'edit original folder' });
  assert.equal(calls[0].cwd, '/workspace');
  assert.equal(calls[0].mode, 'workspace_write');
  api.workspace.isTrusted = false;
  await assert.rejects(tabs.handle(state, { type: 'send', text: 'must not edit' }), /approval expired/);
  assert.equal(calls.length, 1);
  assert.equal(state.mode, 'read_only');
  assert.ok(posted.some(event => event.type === 'mode' && event.mode === 'read_only'));
});

test('removed approved folder and folder changes during approval cannot authorize writes', async () => {
  const { tabs, state, api, calls } = fixture();
  const other = { uri: { fsPath: '/other', toString: () => 'file:///other' } };
  api.window.showWarningMessage = async () => 'Allow workspace writes';
  await tabs.handle(state, { type: 'mode', mode: 'workspace_write' });
  api.workspace.workspaceFolders = [other];
  await assert.rejects(tabs.handle(state, { type: 'send', text: 'must not edit' }), /approval expired/);
  assert.equal(calls.length, 0);
  assert.equal(state.mode, 'read_only');
  api.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace', toString: () => 'file:///workspace' } }];
  api.window.showWarningMessage = async () => {
    api.workspace.workspaceFolders = [other];
    return 'Allow workspace writes';
  };
  await assert.rejects(tabs.handle(state, { type: 'mode', mode: 'workspace_write' }), /changed during approval/);
  assert.equal(state.mode, 'read_only');
});

test('active workspace-write turn stops when its folder is removed', async () => {
  const { tabs, state, api, runtime, posted } = fixture();
  let changed;
  let aborts = 0;
  let finish;
  api.workspace.onDidChangeWorkspaceFolders = callback => {
    changed = callback;
    return { dispose() {} };
  };
  api.window.showWarningMessage = async () => 'Allow workspace writes';
  runtime.run = () => ({ promise: new Promise(resolve => { finish = resolve; }),
    abort() { aborts++; finish(); }, stop() { throw new Error('cooperative stop used'); } });
  await tabs.handle(state, { type: 'mode', mode: 'workspace_write' });
  const pending = tabs.handle(state, { type: 'send', text: 'edit while folder changes' });
  api.workspace.workspaceFolders = [];
  changed();
  await assert.rejects(pending, /approval expired during the turn/);
  assert.equal(aborts, 1);
  assert.equal(state.mode, 'read_only');
  assert.ok(posted.some(event => event.type === 'mode' && event.mode === 'read_only'));
});

test('active workspace-write turn stops after trust is revoked without a VS Code trust event', async () => {
  const { tabs, state, api, runtime } = fixture();
  let aborts = 0;
  let finish;
  api.window.showWarningMessage = async () => 'Allow workspace writes';
  runtime.run = () => ({ promise: new Promise(resolve => { finish = resolve; }),
    abort() { aborts++; finish(); }, stop() { throw new Error('cooperative stop used'); } });
  await tabs.handle(state, { type: 'mode', mode: 'workspace_write' });
  const pending = tabs.handle(state, { type: 'send', text: 'edit while trust changes' });
  api.workspace.isTrusted = false;
  await assert.rejects(pending, /approval expired during the turn/);
  assert.equal(aborts, 1);
  assert.equal(state.mode, 'read_only');
});

test('synchronous SDK event during trust loss still stops the operation after creation', async () => {
  const { tabs, state, api, runtime } = fixture();
  let aborts = 0;
  api.window.showWarningMessage = async () => 'Allow workspace writes';
  await tabs.handle(state, { type: 'mode', mode: 'workspace_write' });
  runtime.run = (_request, onEvent) => {
    api.workspace.isTrusted = false;
    onEvent({ kind: 'turn', turnId: 'turn-1' });
    return { promise: Promise.resolve(), abort() { aborts++; }, stop() { throw new Error('cooperative stop used'); } };
  };
  await assert.rejects(tabs.handle(state, { type: 'send', text: 'must stop' }), /approval expired during the turn/);
  assert.equal(aborts, 1);
  assert.equal(state.mode, 'read_only');
});

test('setup failure leaves the SDK unavailable and reports no ready state', async () => {
  const { tabs, state, runtime, posted } = fixture();
  runtime.ready = false;
  runtime.install = async () => { throw new Error('pip failed'); };
  await assert.rejects(tabs.handle(state, { type: 'setup' }), /pip failed/);
  assert.equal(runtime.ready, false);
  assert.equal(posted.some(event => event.type === 'ready'), false);
});

test('two open panels keep separate state and New chat opens a third panel', async () => {
  const { tabs, state, stored } = fixture();
  tabs.setThread(state, THREAD_A, 'First');
  const panel = { title: '', webview: { asWebviewUri: uri => uri.fsPath, cspSource: 'vscode-resource:',
    postMessage() {}, onDidReceiveMessage() {} }, onDidDispose() {} };
  tabs.attach(panel);
  const second = [...tabs.panels].find(item => item !== state);
  tabs.setThread(second, THREAD_B, 'Second');
  await Promise.all([state.persistence, second.persistence]);
  assert.equal(Object.keys(stored['codexSessionTabs.panelThreads']).length, 2,
    'two distinct panel IDs must write two persisted records');
  let opened = 0;
  tabs.open = () => { opened++; };
  await tabs.handle(state, { type: 'new' });
  assert.equal(opened, 1);
  assert.equal(state.threadId, THREAD_A);
  assert.equal(second.threadId, THREAD_B);
  assert.equal(panel.title, 'Second');
  assert.equal(tabs.owners.get(THREAD_B), second);
});

test('folders with the same basename retain distinct saved tab records', async () => {
  const { tabs, state, api, panel, stored } = fixture();
  tabs.setThread(state, THREAD_A, 'First workspace');
  api.workspace.workspaceFolders = [{ uri: { fsPath: '/other/workspace',
    toString: () => 'file:///other/workspace' } }];
  tabs.attach({ ...panel, webview: { ...panel.webview } });
  const second = [...tabs.panels].find(item => item !== state);
  tabs.setThread(second, THREAD_B, 'Second workspace');
  await Promise.all([state.persistence, second.persistence]);
  const records = Object.values(stored['codexSessionTabs.panelThreads']);
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map(record => record.workspaceKey)),
    new Set(['file:///workspace', 'file:///other/workspace']));
});

test('fresh installs start with a provisional read-only tab', () => {
  const { state } = fixture();
  assert.equal(state.mode, 'read_only');
  assert.equal(state.threadId, null);
});

test('previous extension state does not grant writes or supply a stale thread', () => {
  const { tabs, context, runtime, stored, panel } = fixture();
  stored['codexSessionTabs.aliases'] = { 'codex://old-thread': 'Old title' };
  stored['codexSessionTabs.recent'] = [{ uri: 'codex://old-thread', title: 'Old title' }];
  const migrated = new tabs.constructor(context, runtime);
  const oldUserPanel = { ...panel, title: '', webview: { ...panel.webview } };
  migrated.attach(oldUserPanel);
  const state = [...migrated.panels][0];
  assert.equal(state.mode, 'read_only');
  assert.equal(state.threadId, null);
  assert.equal(state.title, 'New Codex chat');
});

test('restored ID comes from persisted host record while write mode resets', async () => {
  const { tabs, state, context, runtime, stored, panel } = fixture();
  tabs.setThread(state, THREAD_A, 'Persisted title');
  await state.persistence;
  const restored = new tabs.constructor(context, runtime);
  const otherPanel = { ...panel, title: '', webview: { ...panel.webview } };
  restored.attach(otherPanel, { panelId: state.panelId, threadId: THREAD_B,
    title: 'Stale title', mode: 'workspace_write', hostKey: tabs.hostKey, workspaceKey: tabs.workspaceKey });
  const restoredState = [...restored.panels][0];
  assert.equal(restoredState.threadId, THREAD_A);
  assert.equal(restoredState.title, 'Persisted title');
  assert.equal(restoredState.mode, 'read_only');
  assert.equal(Object.keys(stored['codexSessionTabs.panelThreads']).length, 1);
});

test('restored tab finds its saved folder after multi-root reorder', async () => {
  const { tabs, state, context, runtime, api, panel } = fixture();
  tabs.setThread(state, THREAD_A, 'Saved in A');
  await state.persistence;
  const original = api.workspace.workspaceFolders[0];
  const other = { uri: { fsPath: '/other', toString: () => 'file:///other' } };
  api.workspace.workspaceFolders = [other, original];
  const restored = new tabs.constructor(context, runtime);
  restored.attach({ ...panel, webview: { ...panel.webview } }, { panelId: state.panelId,
    threadId: THREAD_A, hostKey: tabs.hostKey, workspaceKey: 'file:///workspace' });
  const next = [...restored.panels][0];
  assert.equal(next.threadId, THREAD_A);
  assert.equal(next.cwd, '/workspace');
  assert.equal(next.workspaceKey, 'file:///workspace');
  assert.equal(next.mode, 'read_only');
});

test('missing saved folder does not bind a thread to another root or erase its record', async () => {
  const { tabs, state, context, runtime, api, panel, stored } = fixture();
  tabs.setThread(state, THREAD_A, 'Saved in A');
  await state.persistence;
  api.workspace.workspaceFolders = [{ uri: { fsPath: '/other', toString: () => 'file:///other' } }];
  let dispose;
  const restored = new tabs.constructor(context, runtime);
  restored.attach({ ...panel, webview: { ...panel.webview }, onDidDispose(callback) { dispose = callback; } },
    { panelId: state.panelId, threadId: THREAD_A, hostKey: tabs.hostKey, workspaceKey: 'file:///workspace' });
  const next = [...restored.panels][0];
  assert.equal(next.threadId, null);
  assert.equal(next.incompatible, true);
  assert.equal(next.cwd, '/other');
  dispose();
  await restored.recordWrite;
  assert.equal(stored['codexSessionTabs.panelThreads'][state.panelId].threadId, THREAD_A);
});

test('persistence rejection does not turn a completed SDK turn into an uncertain retry', async () => {
  const { tabs, state, context, posted, calls } = fixture();
  let saves = 0;
  const originalUpdate = context.workspaceState.update;
  context.workspaceState.update = async (...args) => {
    saves++;
    if (saves === 1) throw new Error('storage unavailable');
    return originalUpdate(...args);
  };
  await tabs.handle(state, { type: 'send', text: 'first' });
  assert.equal(state.threadId, THREAD_A);
  assert.equal(state.busy, false);
  assert.equal(posted.some(event => event.type === 'restoreDraft'), false);
  assert.ok(posted.some(event => event.type === 'status' && /could not save its thread ID/.test(event.text)));
  await tabs.handle(state, { type: 'send', text: 'second' });
  assert.equal(calls[1].threadId, THREAD_A);
  assert.equal(calls.length, 2);
  assert.equal(state.busy, false);
  assert.equal(state.persistenceError, null);
  assert.equal(saves, 2);
  assert.equal(state.persistenceDirty, false);
  assert.equal(context.workspaceState.get('codexSessionTabs.panelThreads')[state.panelId].threadId, THREAD_A);
});

test('webview uses a restrictive CSP and text rendering for SDK output', async () => {
  const { panel } = fixture();
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /connect-src 'none'/);
  const script = await fs.readFile(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  assert.match(script, /node\.textContent = text/);
  assert.doesNotMatch(script, /innerHTML/);
});
