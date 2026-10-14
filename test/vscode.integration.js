'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  assert.ok(codex, 'official Codex extension should be installed');
  const ours = vscode.extensions.all.find(item => item.packageJSON.name === 'yuhan-codex-session-tabs');
  assert.ok(ours, 'development extension should be present');
  await ours.activate();
  const first = await vscode.commands.executeCommand('codexSessionTabs.newTab');
  const second = await vscode.commands.executeCommand('codexSessionTabs.newTab');
  assert.notEqual(first.toString(), second.toString(), 'each command call should use a distinct URI');
  let tabs = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === 'chatgpt.conversationEditor' &&
        [first.toString(), second.toString()].includes(tab.input.uri.toString()));
    if (tabs.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(tabs.length, 2, 'two command calls should create two official Codex editor tabs');
}

module.exports = { run };
