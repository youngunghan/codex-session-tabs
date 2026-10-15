'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

async function run() {
  const before = vscode.window.tabGroups.all.flatMap(group => group.tabs).length;
  await vscode.commands.executeCommand('codexSessionTabs.newTab');
  await vscode.commands.executeCommand('codexSessionTabs.newTab');
  let tabs;
  for (let attempt = 0; attempt < 50; attempt++) {
    tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    if (tabs.length >= before + 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('CODEX_TAB_LABELS', tabs.map(tab => tab.label));
  assert.equal(tabs.length, before + 2, 'both chat panels should be independent editor tabs');
  assert.equal(tabs.filter(tab => tab.label === 'New Codex chat').length, 2,
    'both webview editor tabs should have our title');
  const extension = vscode.extensions.getExtension('youngunghan.yuhan-codex-session-tabs');
  const manager = await extension.activate();
  const [state, secondState] = [...manager.panels];
  manager.setThread(state, '0199ab00-0000-7000-8000-000000000001', 'Before rename');
  manager.setThread(secondState, '0199ab00-0000-7000-8000-000000000002', 'Second thread');
  manager.runtime.ready = true;
  manager.runtime.run = (request, onEvent) => ({
    promise: Promise.resolve().then(() => onEvent({ kind: 'renamed', threadId: request.threadId, name: request.name })),
    stop() {}
  });
  await manager.handle(state, { type: 'rename', name: 'Renamed Codex chat' });
  await Promise.all([state.persistence, secondState.persistence]);
  const stored = manager.context.workspaceState.get('codexSessionTabs.panelThreads', {});
  assert.equal(Object.keys(stored).length, 2,
    'two independent threads must be written as two persisted panel records');
  console.log(`CODEX_KEY_RESULT inputs=2 records_written=${Object.keys(stored).length}`);
  let renamedTabs;
  for (let attempt = 0; attempt < 50; attempt++) {
    renamedTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    if (renamedTabs.some(tab => tab.label === 'Renamed Codex chat')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.panel.title, 'Renamed Codex chat');
  assert.ok(renamedTabs.some(tab => tab.label === 'Renamed Codex chat'),
    'renaming the real SDK thread must immediately update our editor tab label');
  await vscode.window.tabGroups.close(renamedTabs.filter(tab =>
    ['Second thread', 'Renamed Codex chat'].includes(tab.label)));
  if (process.env.CODEX_TABS_TEST_MARKER) fs.writeFileSync(process.env.CODEX_TABS_TEST_MARKER, 'passed');
}

module.exports = { run };
