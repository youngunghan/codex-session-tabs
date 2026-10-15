'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

async function run() {
  const before = vscode.window.tabGroups.all.flatMap(group => group.tabs).length;
  await vscode.commands.executeCommand('codexSessionTabs.newSdkTab');
  await vscode.commands.executeCommand('codexSessionTabs.newSdkTab');
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
  for (const theme of ['light', 'dark']) {
    assert.ok(fs.existsSync(state.panel.iconPath[theme].fsPath), `${theme} editor icon should be packaged`);
  }
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
  if (process.env.CODEX_EXTENSION_PATH) {
    const official = vscode.extensions.getExtension('openai.chatgpt');
    assert.ok(official, 'official Codex must be installed for the original-interface check');
    const first = await vscode.commands.executeCommand('codexSessionTabs.newTab');
    const second = await vscode.commands.executeCommand('codexSessionTabs.newTab');
    assert.ok(first && second, 'default command must open the official editor');
    assert.notEqual(first.toString(), second.toString());
    let officialTabs;
    for (let attempt = 0; attempt < 50; attempt++) {
      officialTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor');
      if ([first, second].every(uri => officialTabs.some(tab => tab.input.uri.toString() === uri.toString()))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(officialTabs.some(tab => tab.input.uri.toString() === first.toString()));
    assert.ok(officialTabs.some(tab => tab.input.uri.toString() === second.toString()));
    console.log('CODEX_OFFICIAL_KEY_RESULT independent_tabs=2 viewType=chatgpt.conversationEditor');
    const historyIds = process.env.CODEX_HISTORY_THREAD_IDS?.split(',');
    if (historyIds?.length === 2 && historyIds.every(id => /^[0-9a-f-]{36}$/.test(id))) {
      const historyUris = historyIds.map(id => vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${id}` }));
      for (const uri of historyUris) {
        // The installed official history handler uses vscode.open without
        // preview:false. Exercise that exact path, with preview enabled.
        await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
        let pinned = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const opened = vscode.window.tabGroups.all.flatMap(group => group.tabs)
            .find(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString());
          if (opened && !opened.isPreview) { pinned = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(pinned, 'each official history preview must become permanent');
      }
      const retained = vscode.window.tabGroups.all.flatMap(group => group.tabs);
      for (const uri of [...historyUris, first, second]) {
        const matching = retained.filter(tab => tab.input instanceof vscode.TabInputCustom &&
          tab.input.uri.toString() === uri.toString());
        assert.equal(matching.length, 1, 'keeping a history tab must not create a duplicate webview editor');
        assert.equal(matching[0].isPreview, false, 'all new and history tabs must remain permanent');
      }
      console.log('CODEX_HISTORY_KEY_RESULT history_tabs=2 pinned=true new_tabs_retained=2');
      await vscode.window.tabGroups.close(retained.filter(tab => tab.input instanceof vscode.TabInputCustom &&
        historyUris.some(uri => uri.toString() === tab.input.uri.toString())));
      // Back-to-back opens do not wait for our listener to pin the first tab.
      for (const uri of historyUris) await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
      for (let attempt = 0; attempt < 100; attempt++) {
        const all = vscode.window.tabGroups.all.flatMap(group => group.tabs);
        if (historyUris.every(uri => all.some(tab => tab.input instanceof vscode.TabInputCustom &&
          tab.input.uri.toString() === uri.toString() && !tab.isPreview))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const consecutive = vscode.window.tabGroups.all.flatMap(group => group.tabs);
      for (const uri of historyUris) assert.equal(consecutive.filter(tab =>
        tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString() && !tab.isPreview).length, 1);
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString(), historyUris[1].toString(),
        'keeping an older history tab must not activate it over the latest selection');
      console.log('CODEX_HISTORY_CONSECUTIVE_KEY_RESULT history_tabs=2 pinned=true duplicates=0');
      officialTabs = consecutive.filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor');
    } else console.log('CODEX_HISTORY_CHECK skipped: supply two diagnostic thread IDs in CODEX_HISTORY_THREAD_IDS.');
    await vscode.window.tabGroups.close(officialTabs);
  } else console.log('CODEX_OFFICIAL_CHECK skipped: set CODEX_EXTENSION_PATH to verify the installed official editor. SDK panels were tested.');
  if (process.env.CODEX_TABS_TEST_MARKER) fs.writeFileSync(process.env.CODEX_TABS_TEST_MARKER, 'passed');
}

module.exports = { run };
