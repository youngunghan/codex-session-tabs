'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');

function webview(saved = {}, autoInit = true) {
  const elements = new Map();
  const posted = [];
  let persisted = saved;
  let onMessage;
  function element() {
    const listeners = new Map();
    return {
      value: '', textContent: '', hidden: false, disabled: false, children: [],
      classList: { toggle() {} },
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type) { listeners.get(type)({ preventDefault() {}, target: this }); },
      appendChild(child) { this.children.push(child); this.lastElementChild = child; },
      replaceChildren() { this.children = []; this.lastElementChild = null; },
      focus() {}
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element
  };
  vm.runInNewContext(source, {
    document,
    window: { addEventListener(type, callback) { if (type === 'message') onMessage = callback; } },
    acquireVsCodeApi: () => ({
      getState: () => persisted,
      setState: value => { persisted = value; },
      postMessage: value => posted.push(value)
    })
  });
  const emit = message => onMessage({ data: message });
  const init = () => emit({ type: 'init', ready: true, threadId: null, title: 'New Codex chat', mode: 'read_only',
    hostKey: 'local|storage', workspaceKey: 'file:///workspace', panelId: 'panel', trusted: true });
  if (autoInit) init();
  return { get: id => document.getElementById(id), posted, emit, init, saved: () => persisted };
}

test('new webview persists an empty draft and no failed prompt', () => {
  const ui = webview();
  assert.equal(ui.get('draft').value, '');
  assert.equal(ui.saved().draft, '');
  assert.equal(ui.saved().failedPrompt, null);
});

test('existing webview hydrates its saved draft and failed prompt', () => {
  const ui = webview({ draft: 'saved draft', failedPrompt: 'older failed prompt' });
  assert.equal(ui.get('draft').value, 'saved draft');
  assert.equal(ui.get('failedPromptPane').hidden, false);
  assert.equal(ui.get('failedPromptText').textContent, 'older failed prompt');
  assert.equal(ui.saved().failedPrompt, 'older failed prompt');
});

test('draft typed before delayed initialization survives saved-state hydration', () => {
  const ui = webview({ draft: 'stale saved draft' }, false);
  ui.get('draft').value = 'new text before init';
  ui.get('draft').dispatch('input');
  assert.equal(ui.saved().draft, 'new text before init');
  ui.init();
  assert.equal(ui.get('draft').value, 'new text before init');
  assert.equal(ui.saved().draft, 'new text before init');
});

test('acknowledging a sent prompt keeps a second draft typed before the user event', () => {
  const ui = webview();
  ui.get('draft').value = 'first prompt';
  ui.get('composer').dispatch('submit');
  assert.equal(ui.posted.at(-1).text, 'first prompt');
  ui.get('draft').value = 'second draft';
  ui.get('draft').dispatch('input');
  ui.emit({ type: 'user', text: 'first prompt' });
  assert.equal(ui.get('draft').value, 'second draft');
  assert.equal(ui.saved().draft, 'second draft');
});

test('failed first prompt is shown separately when a later draft exists', () => {
  const ui = webview();
  ui.get('draft').value = 'first prompt';
  ui.get('composer').dispatch('submit');
  ui.emit({ type: 'user', text: 'first prompt' });
  assert.equal(ui.get('draft').value, '');
  ui.get('draft').value = 'second draft';
  ui.get('draft').dispatch('input');
  ui.emit({ type: 'restoreDraft', text: 'first prompt' });
  assert.equal(ui.get('draft').value, 'second draft');
  assert.equal(ui.get('failedPromptPane').hidden, false);
  assert.equal(ui.get('failedPromptText').textContent, 'first prompt');
  assert.equal(ui.saved().failedPrompt, 'first prompt');
  const restored = webview(ui.saved());
  assert.equal(restored.get('draft').value, 'second draft');
  assert.equal(restored.get('failedPromptText').textContent, 'first prompt');
});
