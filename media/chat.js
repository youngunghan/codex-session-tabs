(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const messages = $('messages');
  const draft = $('draft');
  const history = $('history');
  const status = $('status');
  let state = vscode.getState() || {};
  state.failedPrompts = Array.isArray(state.failedPrompts)
    ? state.failedPrompts.filter(value => typeof value === 'string' && value.length)
    : (state.failedPrompt ? [state.failedPrompt] : []);
  let busy = false;
  let ready = false;
  let nextCursor = null;
  let currentAssistant = null;
  const renderedItems = new Map();

  function persist() {
    state.draft = draft.value;
    vscode.setState({ threadId: state.threadId || null, title: state.title || 'New Codex chat',
      panelId: state.panelId, hostKey: state.hostKey, workspaceKey: state.workspaceKey,
      draft: draft.value, failedPrompts: [...state.failedPrompts], failedPrompt: state.failedPrompts[0] || null });
  }
  function showFailedPrompt() {
    $('failedPromptPane').hidden = state.failedPrompts.length === 0;
    $('failedPromptText').textContent = state.failedPrompts[0] || '';
    $('failedPromptCount').textContent = state.failedPrompts.length > 1
      ? `${state.failedPrompts.length} prompts awaiting review` : '';
  }
  function textNode(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function addMessage(role, text, itemId) {
    const node = textNode('div', `message ${role}`, text);
    messages.appendChild(node);
    messages.scrollTop = messages.scrollHeight;
    if (itemId) renderedItems.set(itemId, node);
    return node;
  }
  function renderMessages(rows) {
    messages.replaceChildren();
    renderedItems.clear();
    currentAssistant = null;
    for (const row of rows) addMessage(row.role, row.text);
  }
  function setBusy(value) {
    busy = value;
    $('send').disabled = value || !ready;
    $('stop').disabled = !value;
    $('rename').disabled = value || !state.threadId;
    $('historyButton').disabled = value || !ready;
    $('mode').disabled = value || !ready;
  }
  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }
  function request(type, extra = {}) {
    vscode.postMessage({ type, ...extra });
  }
  function renderHistory(threads, append) {
    if (!append) history.replaceChildren();
    for (const thread of threads) {
      const button = textNode('button', 'historyItem', thread.name || thread.preview || 'Untitled conversation');
      button.title = [thread.name, thread.preview, thread.cwd].filter(Boolean).join('\n');
      button.addEventListener('click', () => request('select', { threadId: thread.id }));
      history.appendChild(button);
    }
    $('more').hidden = !nextCursor;
    $('historyPane').hidden = false;
  }

  $('setup').addEventListener('click', () => request('setup'));
  $('historyButton').addEventListener('click', () => request('history'));
  $('closeHistory').addEventListener('click', () => { $('historyPane').hidden = true; });
  $('more').addEventListener('click', () => nextCursor && request('historyMore', { cursor: nextCursor }));
  $('new').addEventListener('click', () => request('new'));
  $('stop').addEventListener('click', () => request('stop'));
  $('restoreFailedPrompt').addEventListener('click', () => {
    draft.value = state.failedPrompts.shift() || draft.value;
    showFailedPrompt();
    persist();
    draft.focus();
  });
  $('dismissFailedPrompt').addEventListener('click', () => {
    state.failedPrompts.shift();
    showFailedPrompt();
    persist();
  });
  $('rename').addEventListener('click', () => {
    $('renameInput').value = state.title || '';
    $('renamePane').hidden = false;
    $('renameInput').focus();
  });
  $('cancelRename').addEventListener('click', () => { $('renamePane').hidden = true; });
  $('renameForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('renameInput').value.trim();
    if (name) request('rename', { name });
  });
  $('mode').addEventListener('change', event => request('mode', { mode: event.target.value }));
  $('composer').addEventListener('submit', event => {
    event.preventDefault();
    if (!ready || busy || !draft.value.trim()) return;
    const text = draft.value;
    request('send', { text });
  });
  draft.addEventListener('input', persist);
  draft.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('composer').requestSubmit();
  });

  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'init':
        ready = message.ready;
        state.threadId = message.threadId;
        state.title = message.title;
        state.hostKey = message.hostKey;
        state.workspaceKey = message.workspaceKey;
        state.panelId = message.panelId;
        draft.value = state.draft || '';
        showFailedPrompt();
        $('setupPane').hidden = ready;
        $('mode').value = message.mode;
        $('mode').title = message.trusted ? '' : 'Workspace trust and an open folder are required for writes';
        setStatus(ready ? 'Local files read only · approval requests denied' : 'Set up the official Codex Python SDK to begin.');
        setBusy(!!message.busy);
        persist();
        break;
      case 'ready':
        ready = true;
        $('setupPane').hidden = true;
        setBusy(false);
        setStatus('Codex SDK ready');
        break;
      case 'status': setStatus(message.text, !!message.error); break;
      case 'busy': setBusy(message.value); break;
      case 'thread':
        state.threadId = message.threadId;
        state.title = message.title;
        $('renamePane').hidden = true;
        persist();
        setBusy(busy);
        break;
      case 'user':
        addMessage('user', message.text);
        if (draft.value === message.text) draft.value = '';
        persist();
        currentAssistant = null;
        break;
      case 'delta':
        if (!currentAssistant) currentAssistant = addMessage('assistant', '');
        currentAssistant.textContent += message.text;
        messages.scrollTop = messages.scrollHeight;
        break;
      case 'item':
        if (message.role === 'assistant' && currentAssistant) {
          currentAssistant.textContent = message.text;
          renderedItems.set(message.itemId, currentAssistant);
          currentAssistant = null;
        } else if (!renderedItems.has(message.itemId)) addMessage(message.role, message.text, message.itemId);
        break;
      case 'loaded':
        state.threadId = message.threadId;
        state.title = message.title;
        renderMessages(message.messages);
        $('historyPane').hidden = true;
        persist();
        setBusy(false);
        break;
      case 'loadedChunk':
        for (const row of message.messages) {
          if (row.continuation && messages.lastElementChild) messages.lastElementChild.textContent += row.text;
          else addMessage(row.role, row.text);
        }
        break;
      case 'reset':
        state.threadId = null;
        state.title = 'New Codex chat';
        renderMessages([]);
        persist();
        setBusy(false);
        break;
      case 'closeHistory':
        $('historyPane').hidden = true;
        break;
      case 'history':
        nextCursor = message.nextCursor;
        renderHistory(message.threads, message.append);
        break;
      case 'mode':
        $('mode').value = message.mode;
        setStatus(message.mode === 'workspace_write'
          ? 'Workspace file writes enabled · approval requests denied'
          : 'Local files read only · approval requests denied');
        break;
      case 'restoreDraft':
        if (!draft.value || draft.value === message.text) draft.value = message.text;
        else {
          state.failedPrompts.push(message.text);
          showFailedPrompt();
        }
        persist();
        break;
    }
  });
  request('ready');
})();
