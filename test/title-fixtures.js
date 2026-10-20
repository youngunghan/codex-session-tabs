'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { AutoTitles } = require('../src/auto-titles');
const { TitleStore } = require('../src/title-store');

const A = '0199ab00-0000-7000-8000-000000000001';
const B = '0199ab00-0000-7000-8000-000000000002';
const SOURCE = 'a'.repeat(64), ACCOUNT = 'b'.repeat(64);
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause(5); } throw new Error('fixture condition timed out'); }

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'codex-title-test-'));
  const identity = await fs.lstat(root);
  const defaults = { 'settingsSync.ignoredSettings': [], 'workbench.editor.customLabels.patterns': {}, 'workbench.editor.customLabels.enabled': true, 'codexSessionTabs.autoTitles.enabled': false };
  const values = {};
  const overrides = {};
  const listeners = new Set();
  const writes = [];
  const managers = [];
  const shared = { values, overrides, writes, hook: null };
  const emit = key => { for (const listener of listeners) listener({ affectsConfiguration: name => key === name || key.startsWith(`${name}.`) }); };
  shared.edit = (key, value) => { if (value === undefined) delete values[key]; else values[key] = copy(value); emit(key); };
  shared.fire = emit;
  class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
  function make(name, options = {}) {
    const tabs = (options.ids || [A]).map(id => ({ input: new TabInputCustom({ scheme: 'openai-codex', authority: 'route', path: `/local/${id}` }, 'chatgpt.conversationEditor'), label: id }));
    const warnings = [];
    const api = {
      version: '1.128.0', TabInputCustom, ConfigurationTarget: { Global: 1 }, env: { appName: 'Cursor', remoteName: options.remoteName },
      workspace: {
        workspaceFolders: [{ uri: { toString: () => `file:///synthetic/${name}` } }],
        getConfiguration(section, scope) {
          const snapshot = { ...copy(defaults), ...copy(values) };
          for (const [key, override] of Object.entries(overrides)) if ('workspaceValue' in override) snapshot[key] = copy(override.workspaceValue);
          for (const [key, override] of Object.entries(overrides)) if (scope && 'workspaceFolderValue' in override) snapshot[key] = copy(override.workspaceFolderValue);
          return {
            get(key, fallback) { const full = `${section}.${key}`; return full in snapshot ? copy(snapshot[full]) : fallback; },
            inspect(key) {
              const full = `${section}.${key}`;
              if (!(full in defaults) || overrides[full]?.unregistered) return undefined;
              const override = copy(overrides[full] || {});
              if (!scope) delete override.workspaceFolderValue;
              return { key: full, defaultValue: copy(defaults[full]), globalValue: copy(values[full]), ...override };
            },
            async update(key, value) {
              const full = `${section}.${key}`;
              writes.push({ actor: name, key: full, value: copy(value) });
              await shared.hook?.(full, value, name);
              shared.edit(full, value);
            }
          };
        },
        onDidChangeConfiguration(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
        onDidChangeWorkspaceFolders() { return { dispose() {} }; }
      },
      window: {
        tabGroups: { all: [{ tabs }], onDidChangeTabs() { return { dispose() {} }; } },
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
        showWarningMessage: async message => { warnings.push(message); return undefined; }
      }
    };
    const context = { globalStorageUri: { fsPath: root, toString: () => `file://${root}` }, subscriptions: [] };
    const calls = [];
    const metadata = options.metadata || (async request => { calls.push(request.ids); return { identity: ACCOUNT, threads: request.ids.map(id => ({ id, title: id === A ? 'Fake Alpha' : 'Fake Beta' })) }; });
    const support = options.support || (async () => ({ mode: 'cursor', source: SOURCE, binary: '/synthetic/cli', codexHome: '/synthetic/home' }));
    const store = new TitleStore(path.join(root, 'auto-titles-v1'), options.storeOptions);
    const boundary = options.boundary || { capture: async () => ({ pid: 50001, ticks: '639281000000000000', executable: 'c:\\synthetic\\cursor.exe' }), exited: async () => false };
    const manager = new AutoTitles(context, api, { python: '/not-installed', run() { throw new Error('must not use live SDK'); } }, { metadata, support, store, boundary, timeout: options.timeout });
    if (options.missingRuntime) { delete manager.options.metadata; manager.runtime.python = path.join(root, 'absent-python.exe'); }
    if (options.start !== false) manager.start();
    managers.push(manager);
    return { manager, api, context, store, tabs, calls, warnings };
  }
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.dispose()));
    for (const manager of managers) for (const subscription of manager.context.subscriptions) subscription.dispose?.();
    const resolved = path.resolve(root);
    const stat = await fs.lstat(resolved);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('codex-title-test-'));
    assert.ok(!stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino);
    assert.equal(await fs.realpath(resolved), resolved);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, shared, make };
}

module.exports = { fixture, A, B, SOURCE, ACCOUNT, deferred, until, pause };
