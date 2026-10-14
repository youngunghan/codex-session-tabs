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
  async function waitForPinnedSessions(uris) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const tabs = codexTabs().filter(tab =>
        uris.some(uri => uri.toString() === tab.input.uri.toString()));
      if (tabs.length === uris.length && tabs.every(tab => !tab.isPreview)) return tabs;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const tabs = codexTabs().filter(tab =>
      uris.some(uri => uri.toString() === tab.input.uri.toString()));
    assert.equal(tabs.length, uris.length, 'both history session tabs should remain open');
    assert.ok(tabs.every(tab => !tab.isPreview), 'history session tabs should be pinned when they open');
    return tabs;
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
  const previewConfig = vscode.workspace.getConfiguration('codexSessionTabs');
  const previousPreviewSetting = previewConfig.inspect('replaceNewTabOnHistoryOpen').globalValue;
  await previewConfig.update('replaceNewTabOnHistoryOpen', false, vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand('vscode.openWith', previewSessionUris[0], 'chatgpt.conversationEditor', {
      preview: true, preserveFocus: false
    });
    await waitForPinnedSessions([previewSessionUris[0]]);
    await vscode.commands.executeCommand('vscode.openWith', previewSessionUris[1], 'chatgpt.conversationEditor', {
      preview: true, preserveFocus: false
    });
    const previewSessionTabs = await waitForPinnedSessions(previewSessionUris);
    tabs = await waitForTabs(before.length + 4);
    assert.equal(previewSessionTabs.length, 2, 'opening a second history preview must retain the first session tab');
    await vscode.window.tabGroups.close(previewSessionTabs);
  } finally {
    await previewConfig.update('replaceNewTabOnHistoryOpen', previousPreviewSetting, vscode.ConfigurationTarget.Global);
  }

  await vscode.commands.executeCommand('codexSessionTabs.focusTab', first.toString());
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString(), first.toString());
  assert.equal(codexTabs().length, before.length + 2, 'focusing from the sessions list must not create another tab');

  if (process.env.CODEX_TEST_SESSION_ID) {
    const existingSessionUri = vscode.Uri.parse(`openai-codex://route/local/${process.env.CODEX_TEST_SESSION_ID}`);
    const config = vscode.workspace.getConfiguration('codexSessionTabs');
    const previousGlobalValue = config.inspect('replaceNewTabOnHistoryOpen').globalValue;
    try {
      if (previousGlobalValue === false) {
        assert.equal(config.get('replaceNewTabOnHistoryOpen'), false,
          'a preseeded persisted false should be effective before the default-state check');
        const carriedFalseSource = await vscode.commands.executeCommand('codexSessionTabs.newTab');
        await vscode.commands.executeCommand('codexSessionTabs.focusTab', carriedFalseSource.toString());
        await vscode.commands.executeCommand('vscode.open', existingSessionUri);
        for (let attempt = 0; attempt < 50; attempt++) {
          const opened = codexTabs();
          if (opened.some(tab => tab.input.uri.toString() === carriedFalseSource.toString()) &&
              opened.some(tab => tab.input.uri.toString() === existingSessionUri.toString())) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.ok(codexTabs().some(tab => tab.input.uri.toString() === carriedFalseSource.toString()),
          'a preseeded persisted false should keep its managed source after history selection');
        assert.ok(codexTabs().some(tab => tab.input.uri.toString() === existingSessionUri.toString()),
          'a preseeded persisted false should still open the saved history in its own tab');
        console.log('CODEX_CARRIED_FALSE_RESULT persisted=false source=retained history=open');
        await vscode.window.tabGroups.close(codexTabs().filter(tab =>
          [carriedFalseSource.toString(), existingSessionUri.toString()].includes(tab.input.uri.toString())));
        await vscode.commands.executeCommand('codexSessionTabs.focusTab', first.toString());
      }
      await config.update('replaceNewTabOnHistoryOpen', undefined, vscode.ConfigurationTarget.Global);
      assert.equal(ours.packageJSON.contributes.configuration.properties['codexSessionTabs.replaceNewTabOnHistoryOpen'].default,
        true, 'history replacement should be the packaged default');
      assert.equal(vscode.workspace.getConfiguration('codexSessionTabs').get('replaceNewTabOnHistoryOpen'), true,
        'an unset setting should use the enabled default');
      await vscode.commands.executeCommand('codexSessionTabs.focusTab', first.toString());
      await vscode.commands.executeCommand('vscode.open', existingSessionUri);
      for (let attempt = 0; attempt < 50; attempt++) {
        const opened = codexTabs();
        if (opened.some(tab => tab.input.uri.toString() === existingSessionUri.toString()) &&
            !opened.some(tab => tab.input.uri.toString() === first.toString())) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const defaultHistoryTab = codexTabs().find(tab => tab.input.uri.toString() === existingSessionUri.toString());
      assert.ok(defaultHistoryTab, 'existing Codex session should open');
      assert.ok(!codexTabs().some(tab => tab.input.uri.toString() === first.toString()),
        'the enabled default should replace the active managed new tab');
      assert.ok(codexTabs().some(tab => tab.input.uri.toString() === second.toString()),
        'replacing one managed flow must leave another managed tab open');
      const flowUris = new Set([first.toString(), second.toString(), existingSessionUri.toString()]);
      const retainedFlowTabs = codexTabs().filter(tab => flowUris.has(tab.input.uri.toString()));
      assert.equal(retainedFlowTabs.length, 2,
        'one selected history URI and the independent managed URI should remain across the three tracked inputs');
      // Count identities only; never emit saved conversation URIs or session IDs.
      console.log(`CODEX_KEY_RESULT keys=${flowUris.size} liveTabs=${retainedFlowTabs.length}`);
      if (process.env.CODEX_EXPECT_SESSION_TITLE === '1') {
        for (let attempt = 0; attempt < 50 && defaultHistoryTab.label === 'Codex'; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.notEqual(defaultHistoryTab.label, 'Codex', 'an existing conversation should show its summary as the tab title');
        assert.ok(defaultHistoryTab.label.length > 3, 'the conversation title should be descriptive');
      }

      if (process.env.CODEX_TEST_SESSION_ID_SECOND) {
        assert.notEqual(process.env.CODEX_TEST_SESSION_ID_SECOND, process.env.CODEX_TEST_SESSION_ID,
          'chained history coverage requires two distinct saved sessions');
        const chainedSessionUri = vscode.Uri.parse(`openai-codex://route/local/${process.env.CODEX_TEST_SESSION_ID_SECOND}`);
        await vscode.commands.executeCommand('vscode.open', chainedSessionUri);
        for (let attempt = 0; attempt < 50; attempt++) {
          const opened = codexTabs();
          if (opened.some(tab => tab.input.uri.toString() === chainedSessionUri.toString()) &&
              !opened.some(tab => tab.input.uri.toString() === existingSessionUri.toString())) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(codexTabs().some(tab => tab.input.uri.toString() === chainedSessionUri.toString()),
          'a subsequent saved conversation should open');
        assert.ok(!codexTabs().some(tab => tab.input.uri.toString() === existingSessionUri.toString()),
          'the next history selection should replace the exact history tab adopted by the first');
        assert.ok(codexTabs().some(tab => tab.input.uri.toString() === second.toString()),
          'a chained history selection must leave a separate managed flow untouched');
        const chainedHistoryTab = codexTabs().find(tab => tab.input.uri.toString() === chainedSessionUri.toString());
        await vscode.window.tabGroups.close(chainedHistoryTab);
      } else {
        await vscode.window.tabGroups.close(defaultHistoryTab);
      }

      await config.update('replaceNewTabOnHistoryOpen', false, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('codexSessionTabs.focusTab', second.toString());
      await vscode.commands.executeCommand('vscode.open', existingSessionUri);
      for (let attempt = 0; attempt < 50; attempt++) {
        const opened = codexTabs();
        if (opened.some(tab => tab.input.uri.toString() === second.toString()) &&
            opened.some(tab => tab.input.uri.toString() === existingSessionUri.toString())) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await new Promise(resolve => setTimeout(resolve, 650));
      assert.ok(codexTabs().some(tab => tab.input.uri.toString() === second.toString()),
        'a persisted false preference should retain the active new tab');
      const safeHistoryTab = codexTabs().find(tab => tab.input.uri.toString() === existingSessionUri.toString());
      assert.ok(safeHistoryTab, 'history should open as a separate tab when replacement is disabled');
      await vscode.window.tabGroups.close(safeHistoryTab);

      await config.update('replaceNewTabOnHistoryOpen', true, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('codexSessionTabs.focusTab', second.toString());
      await vscode.commands.executeCommand('codexSessionTabs.reopenSession', { uri: existingSessionUri.toString() });
      for (let attempt = 0; attempt < 50; attempt++) {
        const opened = codexTabs();
        if (opened.some(tab => tab.input.uri.toString() === existingSessionUri.toString()) &&
            opened.some(tab => tab.input.uri.toString() === second.toString())) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await new Promise(resolve => setTimeout(resolve, 650));
      assert.ok(codexTabs().some(tab => tab.input.uri.toString() === existingSessionUri.toString()),
        'recent-session context action should reopen the existing conversation tab');
      assert.ok(codexTabs().some(tab => tab.input.uri.toString() === second.toString()),
        'explicitly reopening a conversation should not close the active new tab');
    } finally {
      await vscode.workspace.getConfiguration('codexSessionTabs')
        .update('replaceNewTabOnHistoryOpen', previousGlobalValue, vscode.ConfigurationTarget.Global);
    }
  }
  if (process.env.CODEX_TABS_TEST_MARKER) fs.writeFileSync(process.env.CODEX_TABS_TEST_MARKER, 'passed');
}

module.exports = { run };
