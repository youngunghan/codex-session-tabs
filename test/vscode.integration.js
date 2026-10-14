'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  assert.ok(codex, 'official Codex extension should be installed');
  const ours = vscode.extensions.all.find(item => item.packageJSON.name === 'yuhan-codex-session-tabs');
  assert.ok(ours, 'development extension should be present');
  await ours.activate();

  const codexTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputCustom &&
      tab.input.viewType === 'chatgpt.conversationEditor');
  async function waitForTabs(count) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const tabs = codexTabs();
      if (tabs.length === count) return tabs;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(codexTabs().length, count, `expected ${count} Codex editor tabs`);
  }

  await codex.activate();
  const initial = codexTabs();
  const isOfficialNewPanel = tab => tab.input.uri.path === '/extension/panel/new' && !tab.input.uri.fragment;
  await vscode.commands.executeCommand('chatgpt.newCodexPanel');
  const before = initial.some(isOfficialNewPanel) ? codexTabs() : await waitForTabs(initial.length + 1);
  const officialTab = before.find(isOfficialNewPanel);
  assert.ok(officialTab, 'official Codex should open its new-panel tab');
  const existingUri = officialTab.input.uri.toString();

  const first = await vscode.commands.executeCommand('codexSessionTabs.newTab');
  let tabs = await waitForTabs(before.length + 1);
  assert.ok(tabs.some(tab => tab.input.uri.toString() === existingUri), 'existing Codex tab must remain after first call');
  assert.ok(tabs.some(tab => tab.input.uri.toString() === first.toString()), 'first new Codex tab must exist');

  const second = await vscode.commands.executeCommand('codexSessionTabs.newTab');
  assert.notEqual(first.toString(), second.toString(), 'each command call should use a distinct URI');
  tabs = await waitForTabs(before.length + 2);
  for (const uri of [existingUri, first.toString(), second.toString()]) {
    assert.ok(tabs.some(tab => tab.input.uri.toString() === uri), `Codex tab ${uri} should remain open`);
  }
}

module.exports = { run };
