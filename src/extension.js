'use strict';

const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { SdkRuntime } = require('./runtime');
const { validateMessage, validThreadId } = require('./protocol');
const { html } = require('./webview');

const VIEW_TYPE = 'codexSessionTabs.chat';
const COMMAND_ID = 'codexSessionTabs.newTab';

function workspacePath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || undefined;
}

function hostKey(context) {
  return `${vscode.env.remoteName || 'local'}|${context.globalStorageUri.toString()}`;
}

function workspaceKey() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() || '';
}

function approvedWorkspacePresent(state) {
  return !!state.cwd && !!vscode.workspace.isTrusted &&
    !!vscode.workspace.workspaceFolders?.some(folder =>
      folder.uri.toString() === state.workspaceKey && folder.uri.fsPath === state.cwd);
}

class ChatTabs {
  constructor(context, runtime) {
    this.context = context;
    this.runtime = runtime;
    this.hostKey = hostKey(context);
    this.workspaceKey = workspaceKey();
    this.records = context.workspaceState.get('codexSessionTabs.panelThreads', {});
    this.recordWrite = Promise.resolve();
    this.panels = new Set();
    this.owners = new Map();
    this.readyPromise = runtime.check();
  }

  open() {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'New Codex chat', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    });
    this.attach(panel);
    return panel;
  }

  attach(panel, saved = {}) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'codex-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'codex-dark.svg')
    };
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    const panelId = validThreadId(saved.panelId) ? saved.panelId : randomUUID();
    const record = this.records[panelId];
    const restored = record?.hostKey === this.hostKey ? record : saved;
    const savedFolder = restored.hostKey === this.hostKey && restored.workspaceKey
      ? vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === restored.workspaceKey)
      : undefined;
    const folder = savedFolder || vscode.workspace.workspaceFolders?.[0];
    const cwd = folder?.uri.fsPath;
    const workspaceId = folder?.uri.toString() || '';
    const compatible = restored.hostKey === this.hostKey && restored.workspaceKey === workspaceId;
    const threadId = compatible && validThreadId(restored.threadId) ? restored.threadId : null;
    const existing = threadId && this.owners.get(threadId);
    if (existing) {
      existing.panel.reveal();
      panel.dispose();
      return;
    }
    const state = {
      panel,
      panelId,
      threadId,
      title: threadId && typeof restored.title === 'string' ? restored.title.slice(0, 200) : 'New Codex chat',
      cwd,
      workspaceKey: workspaceId,
      mode: 'read_only',
      writeApproval: null,
      busy: false,
      operation: null,
      closed: false,
      incompatible: !!restored.threadId && !compatible,
      persistence: Promise.resolve(),
      persistenceError: null,
      persistenceDirty: false
    };
    panel.title = state.title;
    panel.webview.html = html(panel, this.context);
    this.panels.add(state);
    if (threadId) this.owners.set(threadId, state);
    panel.webview.onDidReceiveMessage(raw => {
      const message = validateMessage(raw);
      if (!message) { this.post(state, { type: 'status', text: 'Invalid chat request.', error: true }); return; }
      void this.handle(state, message).catch(error => {
        this.error(state, error);
        if (message.type === 'mode') this.post(state, { type: 'mode', mode: state.mode });
      });
    }, null, this.context.subscriptions);
    panel.onDidDispose(() => {
      state.closed = true;
      state.operation?.stop();
      if (state.threadId && this.owners.get(state.threadId) === state) this.owners.delete(state.threadId);
      if (!state.incompatible) delete this.records[state.panelId];
      void this.saveRecords().catch(error => console.error('Codex chat: failed to save closed tab state', error));
      this.panels.delete(state);
    }, null, this.context.subscriptions);
  }

  post(state, message) {
    if (!state.closed) void state.panel.webview.postMessage(message);
  }

  error(state, error) {
    const busy = /already in use|locked|busy|active owner/i.test(error.message);
    this.post(state, { type: 'status', error: true, text: busy
      ? 'This Codex conversation is busy in another window or tab. Close it there and try again; no lock was changed.'
      : error.outcomeUnknown
        ? `Turn outcome unknown: ${error.message}. Check this conversation before resending; your draft is retained.`
        : error.message });
  }

  saveRecords() {
    const snapshot = { ...this.records };
    this.recordWrite = this.recordWrite.catch(() => {}).then(() =>
      this.context.workspaceState.update('codexSessionTabs.panelThreads', snapshot));
    return this.recordWrite;
  }

  setThread(state, id, title) {
    if (state.closed) return;
    if (!validThreadId(id)) throw new Error('Codex returned an invalid thread ID.');
    const owner = this.owners.get(id);
    if (owner && owner !== state) throw new Error('This conversation is already open in another Codex tab.');
    if (state.threadId && this.owners.get(state.threadId) === state) this.owners.delete(state.threadId);
    state.threadId = id;
    state.title = title || 'Codex chat';
    state.incompatible = false;
    this.owners.set(id, state);
    state.panel.title = state.title;
    this.records[state.panelId] = {
      threadId: id, title: state.title, hostKey: this.hostKey, workspaceKey: state.workspaceKey
    };
    this.persistThread(state);
    this.post(state, { type: 'thread', threadId: id, title: state.title, hostKey: this.hostKey });
  }

  persistThread(state) {
    state.persistenceError = null;
    state.persistence = this.saveRecords().then(() => { state.persistenceDirty = false; }).catch(error => {
      state.persistenceDirty = true;
      state.persistenceError = error;
      console.error('Codex chat: failed to save thread state', error);
    });
  }

  async reportPersistence(state) {
    await state.persistence;
    if (!state.persistenceError) return;
    this.post(state, { type: 'status', error: true,
      text: 'Codex finished, but this tab could not save its thread ID. Keep the tab open and retry after fixing workspace state storage.' });
    state.persistenceError = null;
  }

  async run(state, request, onEvent = () => {}) {
    if (state.busy) throw new Error('This tab is already running a Codex operation.');
    if (!this.runtime.ready) throw new Error('Set up the Codex SDK first.');
    if (state.persistenceDirty) this.persistThread(state);
    state.busy = true;
    this.post(state, { type: 'busy', value: true });
    const watchingWrite = request.op === 'send' && request.mode === 'workspace_write';
    let operation;
    let revoked = false;
    let guardTimer;
    let folderListener;
    const abortOperation = () => {
      try {
        if (operation?.abort) operation.abort();
        else operation?.kill?.();
      } catch (error) {
        console.error('Codex chat: failed to abort revoked write turn', error);
        try { operation?.kill?.(); } catch { /* Process may already have exited. */ }
      }
    };
    const checkWriteApproval = () => {
      if (!watchingWrite || revoked || (approvedWorkspacePresent(state) &&
          state.writeApproval?.cwd === state.cwd && state.writeApproval?.workspaceKey === state.workspaceKey)) return;
      revoked = true;
      state.mode = 'read_only';
      state.writeApproval = null;
      this.post(state, { type: 'mode', mode: state.mode });
      this.post(state, { type: 'status', error: true,
        text: 'Workspace write approval changed during this turn. Stopping Codex.' });
      abortOperation();
    };
    try {
      operation = this.runtime.run({ ...request, cwd: state.cwd }, event => {
        checkWriteApproval();
        if (!revoked) onEvent(event);
      });
      state.operation = operation;
      if (revoked) abortOperation();
      if (watchingWrite) {
        folderListener = vscode.workspace.onDidChangeWorkspaceFolders?.(checkWriteApproval);
        guardTimer = setInterval(checkWriteApproval, 250);
      }
      let operationError;
      try { await operation.promise; }
      catch (error) { operationError = error; }
      checkWriteApproval();
      if (revoked) throw new Error('Workspace write approval expired during the turn; Codex was stopped.');
      if (operationError) throw operationError;
    } finally {
      clearInterval(guardTimer);
      folderListener?.dispose();
      await this.reportPersistence(state);
      state.operation = null;
      state.busy = false;
      this.post(state, { type: 'busy', value: false });
    }
  }

  async load(state, threadId) {
    let loaded;
    const chunks = [];
    await this.run(state, { op: 'load', threadId, mode: 'read_only' }, event => {
      if (event.kind === 'loaded') loaded = event;
      if (event.kind === 'loadedChunk') chunks.push(event.messages);
    });
    if (!loaded) throw new Error('Codex did not return conversation history.');
    this.setThread(state, loaded.thread.id, loaded.thread.name || loaded.thread.preview?.split('\n')[0]?.slice(0, 60));
    this.post(state, { type: 'loaded', threadId: state.threadId, title: state.title, messages: loaded.messages || [] });
    for (const messages of chunks) this.post(state, { type: 'loadedChunk', messages });
    this.post(state, { type: 'status', text: 'Conversation loaded · read only' });
    await this.reportPersistence(state);
  }

  async setup(state) {
    if (this.runtime.ready) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Setting up Codex Python SDK' }, async progress => {
      await this.runtime.install(line => {
        const text = String(line).trim().slice(-400);
        if (text) {
          progress.report({ message: text });
          for (const panel of this.panels) this.post(panel, { type: 'status', text });
        }
      });
    });
    for (const panel of this.panels) this.post(panel, { type: 'ready' });
    if (state.threadId) await this.load(state, state.threadId);
  }

  async handle(state, message) {
    if (state.closed) return;
    if (message.type === 'ready') {
      await this.readyPromise;
      this.post(state, {
        type: 'init', ready: this.runtime.ready, threadId: state.threadId, title: state.title,
        mode: state.mode, busy: state.busy, trusted: approvedWorkspacePresent(state),
        hostKey: this.hostKey, workspaceKey: state.workspaceKey, panelId: state.panelId
      });
      if (state.incompatible) this.post(state, { type: 'status', error: true,
        text: 'This tab came from a different extension host or workspace. Its conversation was not resumed here; use history in the original workspace.' });
      else if (state.threadId && this.runtime.ready) await this.load(state, state.threadId);
      return;
    }
    if (message.type === 'setup') { await this.setup(state); return; }
    if (message.type === 'stop') { state.operation?.stop(); return; }
    if (message.type === 'new') { this.open(); return; }
    if (state.busy) throw new Error('This tab is busy. Stop or wait for its current Codex operation.');
    if (message.type === 'mode') {
      if (message.mode === 'workspace_write') {
        if (!approvedWorkspacePresent(state)) throw new Error('Open and trust this tab’s workspace before enabling writes.');
        const accepted = await vscode.window.showWarningMessage(
          `Allow Codex to edit files in ${state.cwd}? Approval requests remain denied.`,
          { modal: true }, 'Allow workspace writes'
        );
        if (accepted !== 'Allow workspace writes') {
          this.post(state, { type: 'mode', mode: state.mode });
          return;
        }
        if (!approvedWorkspacePresent(state)) throw new Error('This tab’s workspace changed during approval. Try again.');
        state.writeApproval = { cwd: state.cwd, workspaceKey: state.workspaceKey };
      } else {
        state.writeApproval = null;
      }
      state.mode = message.mode;
      this.post(state, { type: 'mode', mode: state.mode });
      return;
    }
    if (message.type === 'history' || message.type === 'historyMore') {
      let page;
      await this.run(state, { op: 'list', cursor: message.cursor }, event => {
        if (event.kind === 'list') page = event;
      });
      if (!page) throw new Error('Codex did not return its history list.');
      state.historyRows ||= new Map();
      for (const row of page.threads) state.historyRows.set(row.id, row);
      this.post(state, { type: 'history', threads: page.threads, nextCursor: page.nextCursor,
        append: message.type === 'historyMore' });
      return;
    }
    if (message.type === 'select') {
      const owner = this.owners.get(message.threadId);
      if (owner && owner !== state) { owner.panel.reveal(); return; }
      if (owner === state) { this.post(state, { type: 'closeHistory' }); return; }
      const selected = state.historyRows?.get(message.threadId);
      if (!selected) throw new Error('Choose a conversation from the current history page.');
      if (state.cwd && selected.cwd && selected.cwd !== state.cwd) {
        const accepted = await vscode.window.showWarningMessage(
          `This conversation belongs to ${selected.cwd}. Open it in the current workspace with read-only access?`,
          { modal: true }, 'Open read only'
        );
        if (accepted !== 'Open read only') return;
      }
      state.mode = 'read_only';
      state.writeApproval = null;
      this.post(state, { type: 'mode', mode: state.mode });
      await this.load(state, message.threadId);
      return;
    }
    if (message.type === 'rename') {
      if (!state.threadId) throw new Error('Send a message before renaming a Codex conversation.');
      let renamed = false;
      await this.run(state, { op: 'rename', threadId: state.threadId, name: message.name, mode: 'read_only' }, event => {
        if (event.kind === 'renamed') renamed = true;
      });
      if (!renamed) throw new Error('Codex did not confirm the rename.');
      this.setThread(state, state.threadId, message.name);
      this.post(state, { type: 'status', text: 'Codex thread renamed.' });
      await this.reportPersistence(state);
      return;
    }
    if (message.type === 'send') {
      if (!this.runtime.ready) throw new Error('Set up the Codex SDK first.');
      if (state.mode === 'workspace_write' && (!approvedWorkspacePresent(state) ||
          state.writeApproval?.cwd !== state.cwd || state.writeApproval?.workspaceKey !== state.workspaceKey)) {
        state.mode = 'read_only';
        state.writeApproval = null;
        this.post(state, { type: 'mode', mode: state.mode });
        throw new Error('Workspace write approval expired. Reopen and trust this tab’s workspace, then allow writes again.');
      }
      let started = false;
      let completed = false;
      try {
        await this.run(state, { op: 'send', threadId: state.threadId, text: message.text, mode: state.mode }, event => {
          if (event.kind === 'thread') this.setThread(state, event.threadId, message.text.trim().split('\n')[0].slice(0, 60));
          if (event.kind === 'turn') {
            started = true;
            this.post(state, { type: 'user', text: message.text });
            this.post(state, { type: 'status', text: 'Codex is working…' });
          }
          if (event.kind === 'delta') this.post(state, { type: 'delta', text: event.text, itemId: event.itemId });
          if (event.kind === 'item') this.post(state, { type: 'item', role: event.role, text: event.text, itemId: event.itemId });
          if (event.kind === 'stopping') this.post(state, { type: 'status', text: 'Stopping Codex turn…' });
          if (event.kind === 'stopIgnored') this.post(state, { type: 'status', text: 'Turn already completed before the stop request.' });
          if (event.kind === 'stopError') this.post(state, { type: 'status', error: true, text: `Stop failed: ${event.message}` });
          if (event.kind === 'completed') {
            completed = true;
            this.post(state, { type: 'status', text: `Turn ${event.status}.` });
          }
        });
        if (!completed) throw new Error('Codex ended without a turn completion event.');
      } catch (error) {
        this.post(state, { type: 'restoreDraft', text: message.text });
        if (started) error.outcomeUnknown = true;
        throw error;
      }
    }
  }
}

function activate(context) {
  const runtime = new SdkRuntime(context, vscode);
  const tabs = new ChatTabs(context, runtime);
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND_ID, () => tabs.open()));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel, state) { tabs.attach(panel, state || {}); }
  }));
  return tabs;
}

module.exports = { activate, ChatTabs, VIEW_TYPE, COMMAND_ID, workspacePath, hostKey };
