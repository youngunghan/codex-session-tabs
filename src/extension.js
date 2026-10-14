'use strict';

const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppServer } = require('./appServer');
const { displayItems } = require('./history');

const VIEW_TYPE = 'codexSessionTabs.chat';
let server;
const panels = new Map();
const byThread = new Map();
const approvals = new Map();
let output;

function nonce() { return crypto.randomBytes(16).toString('base64'); }
function post(panel, message) { return panel.webview.postMessage(message); }

function client() {
  if (!server) {
    const setting = vscode.workspace.getConfiguration('codexSessionTabs');
    server = new AppServer({
      executablePath: setting.get('executablePath', ''),
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
    });
    server.on('diagnostic', text => output.append(String(text)));
    server.on('notification', onNotification);
    server.on('serverRequest', onServerRequest);
    server.on('stopped', error => {
      output.appendLine(error.message);
      approvals.clear();
      for (const [panel, state] of panels) {
        state.turnId = null;
        state.serverInstance = null;
        panel.title = state.title;
        post(panel, { type: 'connectionLost', message: error.message });
      }
      server = undefined;
    });
  }
  return server;
}

async function connectedClient() {
  const current = client();
  await current.start();
  return current;
}

function activeFolder() {
  const file = vscode.window.activeTextEditor?.document.uri;
  if (file) return vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function chooseFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use as Codex project' });
    return picked?.[0]?.fsPath;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const chosen = await vscode.window.showQuickPick(
    folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, cwd: folder.uri.fsPath })),
    { placeHolder: 'Choose the project for this Codex tab' }
  );
  return chosen?.cwd;
}

function panelHtml(panel, extensionUri) {
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  panel.webview.options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] };
  const token = nonce();
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
  const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
  panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${token}';"><link rel="stylesheet" href="${css}"><title>Codex Session Tabs</title></head><body><header><div><strong id="title">Codex</strong><small id="cwd"></small></div><div class="header-actions"><button id="new" title="New chat tab">＋</button><button id="history" title="Open saved chat">History</button></div></header><main id="transcript" role="log" aria-live="polite"></main><section id="approval" hidden></section><footer><div id="status">Connecting…</div><div class="composer"><textarea id="prompt" placeholder="Ask Codex…" rows="3" aria-label="Message"></textarea><div class="composer-actions"><span>Enter to send · Shift+Enter for line break</span><button id="stop" hidden>Stop</button><button id="send">Send</button></div></div></footer><script nonce="${token}" src="${js}"></script></body></html>`;
}

function attachPanel(panel, state, extensionUri) {
  panels.set(panel, state);
  if (state.threadId) byThread.set(state.threadId, panel);
  panel.title = state.title || `Codex · ${path.basename(state.cwd || 'Chat')}`;
  panelHtml(panel, extensionUri);
  panel.onDidDispose(() => {
    panels.delete(panel);
    if (state.threadId && byThread.get(state.threadId) === panel) byThread.delete(state.threadId);
    for (const [id, pending] of approvals) {
      if (pending.panel === panel) {
        approvals.delete(id);
        try { server?.respond(id, { decision: 'decline' }); } catch { /* server already closed */ }
      }
    }
  });
  panel.webview.onDidReceiveMessage(message => handleWebviewMessage(panel, message, extensionUri).catch(error => {
    output.appendLine(error.stack || String(error));
    post(panel, { type: 'error', message: error.message || String(error) });
  }));
}

async function newTab(extensionUri) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust this workspace before starting Codex.');
    return;
  }
  const cwd = await chooseFolder();
  if (!cwd) return;
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `Codex · ${path.basename(cwd)}`, vscode.ViewColumn.Active, {});
  const state = { cwd, title: `Codex · ${path.basename(cwd)}`, threadId: null, turnId: null, serverInstance: null, items: new Map() };
  attachPanel(panel, state, extensionUri);
  post(panel, { type: 'session', threadId: null, cwd, title: state.title });
}

async function openSaved(extensionUri) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust this workspace before opening Codex.');
    return;
  }
  const api = await connectedClient();
  const cwd = activeFolder();
  const result = await api.request('thread/list', {
    limit: 100, sortKey: 'updated_at',
    sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
    ...(cwd ? { cwd } : {})
  });
  const entries = result?.data || [];
  if (!entries.length) { vscode.window.showInformationMessage('No saved Codex chats found for this project.'); return; }
  const picked = await vscode.window.showQuickPick(entries.map(thread => ({
    label: thread.name || thread.preview || thread.id,
    description: thread.cwd || '',
    detail: thread.id,
    thread
  })), { placeHolder: 'Open a saved Codex chat as an editor tab' });
  if (!picked) return;
  const existing = byThread.get(picked.thread.id);
  if (existing) { existing.reveal(); return; }
  const thread = picked.thread;
  const project = thread.cwd || cwd || process.cwd();
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, picked.label, vscode.ViewColumn.Active, {});
  const state = { cwd: project, title: picked.label, threadId: thread.id, turnId: null, serverInstance: null, items: new Map() };
  attachPanel(panel, state, extensionUri);
  await loadSession(panel);
}

async function loadSession(panel) {
  const state = panels.get(panel);
  if (!state?.threadId) return;
  const api = await connectedClient();
  const resumed = await api.request('thread/resume', { threadId: state.threadId, excludeTurns: true });
  state.serverInstance = api;
  state.cwd = resumed?.thread?.cwd || state.cwd;
  state.title = resumed?.thread?.name || state.title;
  panel.title = state.title;
  let turns;
  try {
    const history = await api.request('thread/turns/list', { threadId: state.threadId, limit: 50, sortDirection: 'desc', itemsView: 'full' });
    turns = (history?.data || []).reverse();
  } catch (error) {
    if (!/method not found|unknown method|unsupported method/i.test(error.message)) throw error;
    const legacy = await api.request('thread/read', { threadId: state.threadId, includeTurns: true });
    turns = (legacy?.thread?.turns || []).slice(-50);
  }
  post(panel, { type: 'history', threadId: state.threadId, cwd: state.cwd, title: state.title, messages: displayItems(turns) });
}

async function handleWebviewMessage(panel, message, extensionUri) {
  const state = panels.get(panel);
  if (!state || !message || typeof message.type !== 'string') return;
  if (message.type === 'ready') {
    post(panel, { type: 'session', threadId: state.threadId, cwd: state.cwd, title: state.title });
    if (state.threadId && message.restored) await loadSession(panel);
  } else if (message.type === 'new') {
    await newTab(extensionUri);
  } else if (message.type === 'history') {
    await openSaved(extensionUri);
  } else if (message.type === 'send') {
    const prompt = typeof message.text === 'string' ? message.text.trim() : '';
    if (!prompt || state.turnId) return;
    const api = await connectedClient();
    if (!state.threadId) {
      const started = await api.request('thread/start', { cwd: state.cwd, serviceName: 'codex_session_tabs' });
      if (!started?.thread?.id) throw new Error('Codex did not return a thread ID.');
      state.threadId = started.thread.id;
      state.serverInstance = api;
      byThread.set(state.threadId, panel);
      post(panel, { type: 'session', threadId: state.threadId, cwd: state.cwd, title: state.title });
    } else if (state.serverInstance !== api) {
      await api.request('thread/resume', { threadId: state.threadId, excludeTurns: true });
      state.serverInstance = api;
    }
    const result = await api.request('turn/start', { threadId: state.threadId, input: [{ type: 'text', text: prompt }] });
    state.turnId = result?.turn?.id || null;
    if (state.title.startsWith('Codex · ')) {
      state.title = prompt.replace(/\s+/g, ' ').slice(0, 52);
      panel.title = state.title;
      post(panel, { type: 'session', threadId: state.threadId, cwd: state.cwd, title: state.title });
    }
    post(panel, { type: 'sent', text: prompt, turnId: state.turnId });
  } else if (message.type === 'stop') {
    if (state.threadId && state.turnId) {
      const api = await connectedClient();
      await api.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId });
    }
  } else if (message.type === 'approval') {
    const pending = approvals.get(message.id);
    if (!pending || pending.panel !== panel) return;
    if (!['accept', 'decline'].includes(message.decision)) return;
    approvals.delete(message.id);
    const api = await connectedClient();
    api.respond(message.id, { decision: message.decision });
    post(panel, { type: 'approvalResolved', id: message.id });
    if (![...approvals.values()].some(item => item.panel === panel)) panel.title = state.title;
  }
}

function onNotification(message) {
  const { method, params = {} } = message;
  const panel = byThread.get(params.threadId);
  if (!panel) return;
  const state = panels.get(panel);
  if (!state) return;
  if (method === 'turn/started') {
    state.turnId = params.turn?.id || state.turnId;
    post(panel, { type: 'turnStarted', turnId: state.turnId });
  } else if (method === 'turn/completed') {
    state.turnId = null;
    if (![...approvals.values()].some(item => item.panel === panel)) panel.title = state.title;
    post(panel, { type: 'turnCompleted', status: params.turn?.status, error: params.turn?.error?.message });
  } else if (method === 'item/agentMessage/delta') {
    post(panel, { type: 'delta', id: params.itemId, text: params.delta || '' });
  } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
    post(panel, { type: 'agentMessage', id: params.item.id, text: params.item.text || '' });
  } else if (method === 'item/completed' && ['commandExecution', 'fileChange'].includes(params.item?.type)) {
    state.items.delete(params.item.id);
    post(panel, { type: 'tool', messages: displayItems([{ items: [params.item] }]) });
  } else if (method === 'item/started' && ['commandExecution', 'fileChange'].includes(params.item?.type)) {
    state.items.set(params.item.id, params.item);
  } else if (method === 'serverRequest/resolved') {
    const pending = approvals.get(params.requestId);
    if (pending?.panel === panel) {
      approvals.delete(params.requestId);
      post(panel, { type: 'approvalResolved', id: params.requestId });
      if (![...approvals.values()].some(item => item.panel === panel)) panel.title = state.title;
    }
  } else if (method === 'error') {
    post(panel, { type: 'error', message: params.error?.message || 'Codex reported an error.' });
  }
}

function onServerRequest(message) {
  const method = message.method;
  if (method === 'item/permissions/requestApproval') {
    server.respond(message.id, { permissions: {} });
    return;
  }
  if (method === 'mcpServer/elicitation/request') {
    server.respond(message.id, { action: 'decline', content: null });
    return;
  }
  if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    server.respondError(message.id, `Unsupported request: ${method}`);
    return;
  }
  const panel = byThread.get(message.params?.threadId);
  if (!panel) { server.respond(message.id, { decision: 'decline' }); return; }
  approvals.set(message.id, { panel });
  const p = message.params || {};
  const network = p.networkApprovalContext;
  const item = panels.get(panel).items.get(p.itemId);
  const changes = item?.type === 'fileChange' ? (item.changes || []).map(change => `${change.kind || 'edit'} ${change.path}\n${change.diff || ''}`).join('\n\n') : '';
  const preview = network ? `${network.protocol || ''} ${network.host || ''}`.trim() : p.command || changes || p.reason || 'Review requested action';
  const detail = preview.length > 20000 ? `${preview.slice(0, 20000)}\n… preview truncated` : preview;
  post(panel, { type: 'approval', id: message.id, kind: method.includes('commandExecution') ? 'Command' : 'File change', detail, reason: p.reason || '' });
  panel.title = `● ${panels.get(panel).title}`;
}

function activate(context) {
  output = vscode.window.createOutputChannel('Codex Session Tabs');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('codexSessionTabs.newTab', () => newTab(context.extensionUri)));
  context.subscriptions.push(vscode.commands.registerCommand('codexSessionTabs.openSession', () => openSaved(context.extensionUri)));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel, saved) {
      if (!saved?.cwd) { panel.dispose(); return; }
      const state = { cwd: saved.cwd, title: saved.title || 'Codex', threadId: saved.threadId || null, turnId: null, serverInstance: null, items: new Map() };
      attachPanel(panel, state, context.extensionUri);
    }
  }));
}

function deactivate() { server?.dispose(); }

module.exports = { activate, deactivate, displayItems };
