/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const view = {
  threadId: saved.threadId || null,
  cwd: saved.cwd || '',
  title: saved.title || 'Codex',
  messages: Array.isArray(saved.messages) ? saved.messages : [],
  draft: saved.draft || '',
  busy: false,
  sending: false
};
const transcript = document.getElementById('transcript');
const nodes = new Map();
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const status = document.getElementById('status');
const approval = document.getElementById('approval');

function persist() {
  vscode.setState({ threadId: view.threadId, cwd: view.cwd, title: view.title, messages: view.messages.slice(-300), draft: view.draft });
}

function setStatus(value) { status.textContent = value; }

function controls() {
  send.disabled = view.sending || view.busy || !view.cwd || !prompt.value.trim();
  stop.hidden = !view.busy;
}

function messageElement(message) {
  const card = document.createElement('article');
  card.className = `message ${message.role}`;
  card.dataset.id = String(message.id);
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = message.role === 'user' ? 'You' : message.role === 'tool' ? 'Tool' : 'Codex';
  const body = document.createElement('pre');
  body.textContent = message.text;
  card.append(label, body);
  return card;
}

function render() {
  document.getElementById('title').textContent = view.title;
  document.getElementById('cwd').textContent = view.cwd;
  nodes.clear();
  const cards = view.messages.map(message => {
    const card = messageElement(message);
    nodes.set(message.id, card);
    return card;
  });
  transcript.replaceChildren(...cards);
  transcript.scrollTop = transcript.scrollHeight;
  controls();
  persist();
}

function upsert(id, role, text, replace = false) {
  const key = String(id || `${role}-${Date.now()}-${Math.random()}`);
  const found = view.messages.find(message => message.id === key);
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  if (found) {
    found.text = replace ? text : found.text + text;
    nodes.get(key)?.querySelector('pre')?.replaceChildren(document.createTextNode(found.text));
  } else {
    const message = { id: key, role, text };
    view.messages.push(message);
    const card = messageElement(message);
    nodes.set(key, card);
    transcript.append(card);
  }
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
  persist();
}

function showApproval(message) {
  approval.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = `${message.kind} approval requested`;
  const detail = document.createElement('pre');
  detail.textContent = [message.detail, message.reason].filter(Boolean).join('\n');
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  for (const [label, decision] of [['Allow once', 'accept'], ['Decline', 'decline']]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'approval', id: message.id, decision });
      actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
    });
    actions.append(button);
  }
  approval.append(title, detail, actions);
  approval.hidden = false;
}

window.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'session' || message.type === 'history') {
    view.threadId = message.threadId;
    view.cwd = message.cwd || view.cwd;
    view.title = message.title || view.title;
    if (message.type === 'history') view.messages = message.messages || [];
    setStatus('Ready');
  } else if (message.type === 'sent') {
    view.sending = false;
    view.busy = true;
    upsert(`user-${message.turnId || Date.now()}`, 'user', message.text, true);
    prompt.value = '';
    view.draft = '';
    setStatus('Codex is working…');
  } else if (message.type === 'turnStarted') {
    view.busy = true;
    setStatus('Codex is working…');
  } else if (message.type === 'turnCompleted') {
    view.busy = false;
    view.sending = false;
    setStatus(message.error || (message.status === 'interrupted' ? 'Stopped' : 'Ready'));
  } else if (message.type === 'delta') {
    upsert(message.id, 'assistant', message.text || '');
  } else if (message.type === 'agentMessage') {
    upsert(message.id, 'assistant', message.text || '', true);
  } else if (message.type === 'tool') {
    for (const item of message.messages || []) upsert(item.id, item.role, item.text, true);
  } else if (message.type === 'approval') {
    showApproval(message);
    setStatus('Approval needed');
  } else if (message.type === 'approvalResolved') {
    approval.hidden = true;
    approval.replaceChildren();
    setStatus('Codex is working…');
  } else if (message.type === 'error' || message.type === 'connectionLost') {
    view.sending = false;
    view.busy = false;
    setStatus(message.message || 'Connection failed');
  }
  if (message.type === 'session' || message.type === 'history') render();
  else { controls(); persist(); }
});

prompt.value = view.draft;
prompt.addEventListener('input', () => {
  view.draft = prompt.value;
  persist();
  controls();
});
prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send.click();
  }
});
send.addEventListener('click', () => {
  const text = prompt.value.trim();
  if (!text || !view.cwd || view.busy || view.sending) return;
  view.sending = true;
  setStatus('Sending…');
  controls();
  vscode.postMessage({ type: 'send', text });
});
stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'new' }));
document.getElementById('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));
render();
vscode.postMessage({ type: 'ready', restored: Boolean(saved.threadId) });
