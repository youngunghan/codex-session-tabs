'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'yuhan-codex-session-tabs');
  assert.ok(extension, 'development extension should be present');
  await extension.activate();
  await vscode.commands.executeCommand('codexSessionTabs.newTab');
  await vscode.commands.executeCommand('codexSessionTabs.newTab');
  let tabs = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input?.viewType?.endsWith('codexSessionTabs.chat'));
    if (tabs.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(tabs.length, 2, 'two command calls should create two independent editor tabs');
}

module.exports = { run };
