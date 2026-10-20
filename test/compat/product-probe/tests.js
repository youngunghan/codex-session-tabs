'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const A = '0199ab00-0000-7000-8000-000000000001';
const B = '0199ab00-0000-7000-8000-000000000002';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 120; i++) { if (check()) return; await delay(100); } throw new Error('Isolated title assertion timed out'); }
exports.run = async () => {
  const report = { status: 'running', fakeProvider: true, fakeMetadata: true, productVersion: process.env.TITLE_PRODUCT_VERSION, apiVersion: vscode.version, appName: vscode.env.appName, mode: process.env.TITLE_APP };
  let manager, provider;
  const subscriptions = [];
  try {
    // This bounded test-only delay avoids quitting Cursor during its initial
    // startup. It says nothing about official renderer readiness.
    if (process.env.TITLE_APP === 'cursor') await delay(6000);
    const root = process.env.TITLE_SOURCE_ROOT;
    const { AutoTitles, PATTERNS } = require(path.join(root, 'src/auto-titles'));
    const { createSupport } = require(path.join(root, 'src/title-support'));
    provider = vscode.window.registerCustomEditorProvider('chatgpt.conversationEditor', {
      openCustomDocument: uri => ({ uri, dispose() {} }),
      resolveCustomEditor(document, panel) {
        panel.title = document.uri.path.endsWith(A) ? 'FAKE native Alpha' : 'FAKE native Beta';
        panel.webview.html = '<!doctype html><h1>FAKE title capability provider</h1><p>No official renderer or conversation is loaded.</p>';
      }
    }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false });
    const labels = () => vscode.workspace.getConfiguration('workbench.editor.customLabels');
    await labels().update('patterns', { '**/unrelated-source/**': 'FAKE user pattern' }, vscode.ConfigurationTarget.Global);
    for (const id of [A, B]) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(`openai-codex://route/local/${id}`), 'chatgpt.conversationEditor', { preview: false });
    const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor');
    await until(() => tabs().length === 2);
    const context = { subscriptions, globalStorageUri: vscode.Uri.file(path.join(process.env.TITLE_GENERATED_ROOT, 'manager-storage')) };
    const officialPath = process.env.TITLE_OFFICIAL_PATH;
    const official = { extensionPath: officialPath, packageJSON: JSON.parse(fs.readFileSync(path.join(officialPath, 'package.json'), 'utf8')) };
    // Only the installed manifest/path is inspected. The official extension is
    // not loaded, and no credentials or user profile are available here.
    const support = createSupport({ env: vscode.env, version: vscode.version, extensions: { getExtension: id => id === 'openai.chatgpt' ? official : undefined } }, context);
    report.supportMode = (await support()).mode;
    assert.equal(report.supportMode, process.env.TITLE_APP === 'cursor' ? 'cursor' : 'native');
    let calls = 0;
    manager = new AutoTitles(context, vscode, {}, { support, metadata: async request => { calls++; return { identity: 'b'.repeat(64), threads: request.ids.map(id => ({ id, title: id === A ? 'FAKE metadata Alpha' : 'FAKE metadata Beta' })) }; } }).start();
    report.defaultOffNoMetadata = calls === 0;
    await manager.enable();
    if (process.env.TITLE_APP === 'cursor') {
      await until(() => tabs().find(tab => tab.input.uri.path.endsWith(A))?.label === 'FAKE metadata Alpha');
      report.inactiveLabelMatchesFakeMetadata = tabs().some(tab => !tab.isActive && tab.label === 'FAKE metadata Alpha');
      assert.equal(report.inactiveLabelMatchesFakeMetadata, true);
      report.exclusionVerified = manager.configuration(true).ok;
      assert.equal(report.exclusionVerified, true);
      assert.equal(labels().inspect('patterns').globalValue['**/unrelated-source/**'], 'FAKE user pattern');
      await vscode.workspace.getConfiguration('settingsSync').update('ignoredSettings', [], vscode.ConfigurationTarget.Global);
      await manager.refresh();
      const values = labels().inspect('patterns').globalValue;
      report.removalPreservedUserPattern = values['**/unrelated-source/**'] === 'FAKE user pattern';
      report.removalCleanedOwnedValues = !values[`**/local/${A}`] && !values[`**/local/${B}`];
      report.removalBlockedWithoutReadding = manager.status.kind === 'blocked' && !vscode.workspace.getConfiguration('settingsSync').get('ignoredSettings').includes(PATTERNS);
      assert.ok(report.removalPreservedUserPattern && report.removalCleanedOwnedValues && report.removalBlockedWithoutReadding);
    } else {
      await until(() => tabs().some(tab => !tab.isActive && tab.label === 'FAKE native Alpha'));
      report.nativeTitlePreserved = tabs().some(tab => !tab.isActive && tab.label === 'FAKE native Alpha');
      report.noMetadataOrPatternOverride = calls === 0 && Object.keys(labels().inspect('patterns').globalValue).length === 1 && !vscode.workspace.getConfiguration('settingsSync').inspect('ignoredSettings').globalValue;
      assert.ok(report.nativeTitlePreserved && report.noMetadataOrPatternOverride);
    }
    report.metadataCalls = calls;
    report.status = 'completed'; report.probeFinished = true;
  } catch (error) { report.status = 'failed'; report.failureType = error.constructor?.name || 'Error'; throw error; }
  finally {
    await manager?.dispose();
    for (const subscription of subscriptions) subscription.dispose();
    provider?.dispose();
    fs.writeFileSync(process.env.TITLE_REPORT, JSON.stringify(report, null, 2));
  }
};
