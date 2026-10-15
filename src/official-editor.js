'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const EXTENSION_ID = 'openai.chatgpt';
const EDITOR_ID = 'chatgpt.conversationEditor';
const NEW_PANEL_PATH = '/extension/panel/new';
const verifiedBundles = new Map();

async function checkOfficialEditor(api) {
  const extension = api.extensions.getExtension(EXTENSION_ID);
  if (!extension) throw new Error('Install the official Codex extension (openai.chatgpt) in this window to use its original interface.');
  const editors = extension.packageJSON?.contributes?.customEditors || [];
  if (!editors.some(editor => editor.viewType === EDITOR_ID)) {
    throw new Error('This official Codex version does not register its conversation editor.');
  }
  const main = extension.packageJSON?.main;
  if (typeof main !== 'string' || !main || path.isAbsolute(main)) {
    throw new Error('Cannot locate the official Codex extension entry point.');
  }
  const mainPath = path.resolve(extension.extensionPath, main);
  const relative = path.relative(extension.extensionPath, mainPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The official Codex entry point is outside its installation folder.');
  }
  const key = `${mainPath}|${extension.packageJSON.version || ''}`;
  if (!verifiedBundles.has(key)) {
    const check = (async () => {
      let bundle;
      try { bundle = await fs.readFile(mainPath, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT' || path.extname(mainPath)) throw error;
        bundle = await fs.readFile(`${mainPath}.js`, 'utf8');
      }
      if (!bundle.includes(NEW_PANEL_PATH)) {
        throw new Error('This official Codex version does not expose the expected new-tab route.');
      }
    })();
    verifiedBundles.set(key, check);
    check.catch(() => verifiedBundles.delete(key));
  }
  await verifiedBundles.get(key);
}

async function openOfficialTab(api) {
  await checkOfficialEditor(api);
  const uri = api.Uri.from({
    scheme: 'openai-codex', authority: 'route', path: NEW_PANEL_PATH,
    fragment: `codex-session-tabs-${randomUUID()}`
  });
  await api.commands.executeCommand('vscode.openWith', uri, EDITOR_ID, {
    viewColumn: api.ViewColumn.Active, preview: false, preserveFocus: false
  });
  return uri;
}

function retainOfficialHistoryTabs(api, reportError = console.error) {
  let disposed = false;
  const attempted = new WeakSet();
  const pin = tab => {
    if (disposed || attempted.has(tab) || !tab.isPreview ||
        !(tab.input instanceof api.TabInputCustom) || tab.input.viewType !== EDITOR_ID) return;
    const uri = tab.input.uri;
    if (uri.scheme !== 'openai-codex' || uri.authority !== 'route' ||
        !/^\/(local|remote)\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i.test(uri.path)) return;
    // Keep Editor pins the existing webview without reopening the document,
    // activating it, or recreating a panel the user has just closed.
    const group = api.window.tabGroups.all.find(item => item.tabs.includes(tab));
    if (!group || !tab.isPreview) return;
    attempted.add(tab);
    void (async () => {
      try {
        await api.commands.executeCommand('workbench.action.keepEditor', uri);
      } catch (error) {
        if (!disposed) reportError('Codex Session Tabs: failed to keep a history tab open', error);
      }
    })();
  };
  const listener = api.window.tabGroups.onDidChangeTabs(event => {
    for (const tab of [...event.opened, ...event.changed]) pin(tab);
  });
  for (const group of api.window.tabGroups.all) for (const tab of group.tabs) pin(tab);
  return { dispose() { disposed = true; listener.dispose(); } };
}

module.exports = { openOfficialTab, checkOfficialEditor, retainOfficialHistoryTabs, EDITOR_ID, NEW_PANEL_PATH };
