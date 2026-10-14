'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

  const sessionUris = ['session-one', 'session-two'].map(id =>
    vscode.Uri.parse(`openai-codex://route/local/${id}`));
  for (const uri of sessionUris) {
    await vscode.commands.executeCommand('codexSessionTabs.reopenSession', { uri: uri.toString() });
  }
  tabs = await waitForTabs(before.length + 4);
  for (const uri of sessionUris) {
    assert.ok(tabs.some(tab => tab.input.uri.toString() === uri.toString()),
      `reopening ${uri.toString()} should create its own Codex editor tab`);
  }
  await vscode.window.tabGroups.close(tabs.filter(tab =>
    sessionUris.some(uri => uri.toString() === tab.input.uri.toString())));

  const previewSessionUris = ['preview-one', 'preview-two'].map(id =>
    vscode.Uri.parse(`openai-codex://route/local/${id}`));
  for (const uri of previewSessionUris) {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'chatgpt.conversationEditor', {
      preview: true, preserveFocus: false
    });
  }
  tabs = await waitForTabs(before.length + 4);
  const previewSessionTabs = tabs.filter(tab =>
    previewSessionUris.some(uri => uri.toString() === tab.input.uri.toString()));
  assert.equal(previewSessionTabs.length, 2, 'opening a second history preview must retain the first session tab');
  assert.ok(previewSessionTabs.every(tab => !tab.isPreview), 'history session tabs should be pinned when they open');
  await vscode.window.tabGroups.close(previewSessionTabs);

  await vscode.commands.executeCommand('codexSessionTabs.focusTab', first.toString());
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString(), first.toString());
  assert.equal(codexTabs().length, before.length + 2, 'focusing from the sessions list must not create another tab');

  if (process.env.CODEX_TEST_SESSION_ID) {
    const existingSessionUri = vscode.Uri.parse(`openai-codex://route/local/${process.env.CODEX_TEST_SESSION_ID}`);
    const config = vscode.workspace.getConfiguration('codexSessionTabs');
    await config.update('replaceNewTabOnHistoryOpen', false, vscode.ConfigurationTarget.Global);
    assert.equal(ours.packageJSON.contributes.configuration.properties['codexSessionTabs.replaceNewTabOnHistoryOpen'].default,
      false, 'safe mode should be the packaged default');
    await vscode.commands.executeCommand('vscode.open', existingSessionUri, { preview: false });
    assert.ok(codexTabs().some(tab => tab.input.uri.toString() === first.toString()),
      'opening history in safe mode should retain the active new tab');
    const safeHistoryTab = codexTabs().find(tab => tab.input.uri.toString() === existingSessionUri.toString());
    assert.ok(safeHistoryTab, 'history should open as a separate tab in safe mode');
    await vscode.window.tabGroups.close(safeHistoryTab);
    await config.update('replaceNewTabOnHistoryOpen', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('codexSessionTabs.focusTab', first.toString());
    await vscode.commands.executeCommand('vscode.open', existingSessionUri, { preview: false });
    for (let attempt = 0; attempt < 50; attempt++) {
      const opened = codexTabs();
      if (opened.some(tab => tab.input.uri.toString() === existingSessionUri.toString()) &&
          !opened.some(tab => tab.input.uri.toString() === first.toString())) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const sessionTab = codexTabs().find(tab => tab.input.uri.toString() === existingSessionUri.toString());
    assert.ok(sessionTab, 'existing Codex session should open');
    assert.ok(!codexTabs().some(tab => tab.input.uri.toString() === first.toString()),
      'opening history should replace the active managed new tab');
    for (let attempt = 0; attempt < 50 && sessionTab.label === 'Codex'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.notEqual(sessionTab.label, 'Codex', 'an existing conversation should show its summary as the tab title');
    assert.ok(sessionTab.label.length > 3, 'the conversation title should be descriptive');
    await vscode.window.tabGroups.close(sessionTab);
    await vscode.commands.executeCommand('codexSessionTabs.focusTab', second.toString());
    await vscode.commands.executeCommand('codexSessionTabs.reopenSession', { uri: existingSessionUri.toString() });
    assert.ok(codexTabs().some(tab => tab.input.uri.toString() === existingSessionUri.toString()),
      'recent-session context action should reopen the existing conversation tab');
    assert.ok(codexTabs().some(tab => tab.input.uri.toString() === second.toString()),
      'explicitly reopening a conversation should not close the active new tab');
  }
  if (process.env.CODEX_TABS_TEST_MARKER) fs.writeFileSync(process.env.CODEX_TABS_TEST_MARKER, 'passed');
}

module.exports = { run };
