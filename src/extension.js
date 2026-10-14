'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { EDITOR_ID, MANAGED_NEW_FRAGMENT, isCodexTab, openCodexTabs, isResumableUri, isManagedNewUri, rememberClosed } = require('./sessions');

const CODEX_EXTENSION_ID = 'openai.chatgpt';
const NEW_PANEL_PATH = '/extension/panel/new';
const COMMAND_ID = 'codexSessionTabs.newTab';
const ALIASES_KEY = 'codexSessionTabs.aliases';
const RECENT_KEY = 'codexSessionTabs.recent';
const REPLACEMENT_WINDOW_MS = 1000;
const verifiedBundles = new Map();

async function checkCodexEditor(requireNewPanelRoute = true) {
  const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
  if (!extension) throw new Error('Install the official Codex extension (openai.chatgpt) in this VS Code/Cursor window.');

  const editors = extension.packageJSON?.contributes?.customEditors || [];
  if (!editors.some(editor => editor.viewType === EDITOR_ID)) {
    throw new Error(`Installed Codex ${extension.packageJSON?.version || ''} does not register ${EDITOR_ID}.`);
  }

  if (!requireNewPanelRoute) return extension;

  const main = extension.packageJSON?.main;
  if (typeof main !== 'string' || !main || path.isAbsolute(main)) {
    throw new Error('Cannot locate the installed Codex extension entry point.');
  }
  const mainPath = path.resolve(extension.extensionPath, main);
  const relative = path.relative(extension.extensionPath, mainPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Codex extension entry point is outside its installation folder.');
  }
  const cacheKey = `${extension.extensionPath}|${extension.packageJSON?.version || ''}|${main}`;
  if (!verifiedBundles.has(cacheKey)) {
    const verification = (async () => {
      let bundle;
      try {
        try {
          bundle = await fs.readFile(mainPath, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT' || path.extname(mainPath)) throw error;
          bundle = await fs.readFile(`${mainPath}.js`, 'utf8');
        }
      } catch (error) {
        throw new Error(`Cannot read the installed Codex extension entry point: ${error.message}`);
      }
      if (!bundle.includes(NEW_PANEL_PATH)) {
        throw new Error(`Installed Codex ${extension.packageJSON?.version || ''} does not contain ${NEW_PANEL_PATH}.`);
      }
    })();
    verifiedBundles.set(cacheKey, verification);
    verification.catch(() => verifiedBundles.delete(cacheKey));
  }
  await verifiedBundles.get(cacheKey);
  return extension;
}

function newPanelUri() {
  // Codex's route URI has no conversation ID. A unique fragment gives every
  // openWith call its own document identity while preserving the route path.
  return vscode.Uri.from({
    scheme: 'openai-codex',
    authority: 'route',
    path: NEW_PANEL_PATH,
    fragment: `${MANAGED_NEW_FRAGMENT}${crypto.randomUUID()}`
  });
}

async function openNewTab() {
  await checkCodexEditor();
  const uri = newPanelUri();
  await vscode.commands.executeCommand('vscode.openWith', uri, EDITOR_ID, {
    viewColumn: vscode.ViewColumn.Active,
    preview: false,
    preserveFocus: false
  });
  return uri;
}

class HistoryTabReplacement {
  constructor(api = vscode) {
    this.api = api;
    this.previousActive = this.active();
    this.pending = undefined;
    this.suppressed = new Map();
  }

  active() {
    const group = this.api.window.tabGroups.activeTabGroup;
    return group?.activeTab ? { group, tab: group.activeTab } : undefined;
  }

  syncActive() {
    this.previousActive = this.active();
  }

  suppress(uri) {
    this.unsuppress(uri);
    const timeout = setTimeout(() => this.unsuppress(uri), 10000);
    timeout.unref?.();
    this.suppressed.set(uri, timeout);
  }

  unsuppress(uri) {
    const timeout = this.suppressed.get(uri);
    if (timeout) clearTimeout(timeout);
    this.suppressed.delete(uri);
  }

  async onTabsChanged(event) {
    const previous = this.previousActive;
    const current = this.active();
    const openedHistory = event.opened.find(tab =>
      isCodexTab(tab, this.api) && isResumableUri(tab.input.uri));
    const historyUri = openedHistory?.input.uri.toString();
    const suppressed = historyUri && this.suppressed.has(historyUri);
    if (suppressed) this.unsuppress(historyUri);
    const enabled = this.api.workspace?.getConfiguration?.('codexSessionTabs')
      ?.get('replaceNewTabOnHistoryOpen', false) ?? false;
    if (enabled && !suppressed && openedHistory && previous &&
        isCodexTab(previous.tab, this.api) && isManagedNewUri(previous.tab.input.uri) &&
        previous.group.tabs.includes(previous.tab) &&
        previous.group.tabs.includes(openedHistory) &&
        (current?.tab === previous.tab || current?.tab === openedHistory)) {
      this.pending = { original: previous.tab, history: openedHistory, group: previous.group, at: Date.now() };
    }

    const pending = this.pending;
    const shouldReplace = pending && current?.tab === pending.history &&
      current.group === pending.group && pending.group.tabs.includes(pending.original) &&
      Date.now() - pending.at < REPLACEMENT_WINDOW_MS;
    this.previousActive = current;
    if (shouldReplace) {
      this.pending = undefined;
      try {
        await this.api.window.tabGroups.close(pending.original, true);
      } catch (error) {
        console.error('Codex Sessions: failed to replace the new tab', error);
      }
      this.previousActive = this.active();
    } else if (pending && (Date.now() - pending.at >= REPLACEMENT_WINDOW_MS ||
        (current?.tab !== pending.original && current?.tab !== pending.history))) {
      this.pending = undefined;
    }
  }
}

class SessionTree {
  constructor(context) {
    this.context = context;
    this.aliases = context.workspaceState.get(ALIASES_KEY, {});
    this.recent = context.workspaceState.get(RECENT_KEY, []);
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  }

  dispose() {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  refresh() {
    this.onDidChangeTreeDataEmitter.fire();
  }

  open() {
    return openCodexTabs(vscode.window.tabGroups.all, vscode);
  }

  visibleRecent() {
    const openUris = new Set(this.open().map(item => item.uri));
    return this.recent.filter(item => !openUris.has(item.uri));
  }

  getChildren(section) {
    if (!section) return [
      { kind: 'section', label: `Open tabs (${this.open().length})`, section: 'open' },
      { kind: 'section', label: `Recently closed (${this.visibleRecent().length})`, section: 'recent' }
    ];
    if (section.section === 'open') return this.open().map(item => ({ kind: 'open', ...item }));
    if (section.section === 'recent') return this.visibleRecent().map(item => ({ kind: 'recent', ...item }));
    return [];
  }

  getTreeItem(item) {
    if (item.kind === 'section') {
      const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Expanded);
      treeItem.id = `section:${item.section}`;
      return treeItem;
    }
    const label = this.aliases[item.uri] || item.label || item.tab?.label || 'Codex conversation';
    const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    treeItem.id = `${item.kind}:${item.uri}:${item.group?.viewColumn ?? ''}`;
    treeItem.contextValue = item.kind === 'open' ? 'codexOpenTab' : 'codexRecentSession';
    if (item.kind === 'open') {
      const selected = item.group.isActive && item.tab.isActive;
      treeItem.description = selected ? 'Selected' : 'Open';
      treeItem.iconPath = new vscode.ThemeIcon(selected ? 'circle-filled' : 'circle-outline');
      treeItem.tooltip = `${label}\n${treeItem.description}. This is the editor tab state, not the Codex turn status.`;
      treeItem.command = { command: 'codexSessionTabs.focusTab', title: 'Focus Codex Tab', arguments: [item.uri, item.group.viewColumn] };
    } else {
      treeItem.description = 'Closed';
      treeItem.iconPath = new vscode.ThemeIcon('history');
      treeItem.tooltip = `${label}\nReopen this saved Codex conversation.`;
      treeItem.command = { command: 'codexSessionTabs.reopenSession', title: 'Reopen Codex Session', arguments: [item.uri] };
    }
    return treeItem;
  }

  async onTabsChanged(event) {
    let changed = false;
    let recentChanged = false;
    let aliasesChanged = false;
    const openUris = new Set(this.open().map(item => item.uri));
    for (const tab of event.closed) {
      if (!isCodexTab(tab, vscode)) continue;
      const uri = tab.input.uri.toString();
      if (openUris.has(uri)) {
        changed = true;
        continue;
      }
      if (isResumableUri(tab.input.uri)) {
        this.recent = rememberClosed(this.recent, { uri, label: tab.label });
        recentChanged = true;
      }
      else if (this.aliases[uri]) {
        delete this.aliases[uri];
        aliasesChanged = true;
      }
      changed = true;
    }
    if (event.opened.length) {
      if (event.opened.some(tab => isCodexTab(tab, vscode))) changed = true;
      const next = this.recent.filter(item => !openUris.has(item.uri));
      if (next.length !== this.recent.length) {
        this.recent = next;
        changed = true;
        recentChanged = true;
      }
    }
    const retained = new Set([...openUris, ...this.recent.map(item => item.uri)]);
    for (const uri of Object.keys(this.aliases)) {
      if (retained.has(uri)) continue;
      delete this.aliases[uri];
      aliasesChanged = true;
    }
    if (recentChanged) await this.context.workspaceState.update(RECENT_KEY, this.recent);
    if (aliasesChanged) await this.context.workspaceState.update(ALIASES_KEY, this.aliases);
    if (changed || event.changed.some(tab => isCodexTab(tab, vscode))) this.refresh();
  }

  async rename(uri, label) {
    if (label) this.aliases[uri] = label;
    else delete this.aliases[uri];
    await this.context.workspaceState.update(ALIASES_KEY, this.aliases);
    this.refresh();
  }
}

function activate(context) {
  const open = async () => {
    try {
      return await openNewTab();
    } catch (error) {
      vscode.window.showErrorMessage(`Codex: New Codex Tab failed: ${error.message}`);
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND_ID, open));

  const sessions = new SessionTree(context);
  const replacement = new HistoryTabReplacement();
  context.subscriptions.push(sessions);
  context.subscriptions.push(vscode.window.createTreeView('codexSessionTabs.sessions', {
    treeDataProvider: sessions,
    showCollapseAll: true
  }));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event => {
    void sessions.onTabsChanged(event).catch(error => console.error('Codex Sessions: failed to save tab state', error));
    void replacement.onTabsChanged(event).catch(error => console.error('Codex Sessions: failed to replace tab', error));
  }));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(() => {
    replacement.syncActive();
    sessions.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codexSessionTabs.focusTab', async (uri, viewColumn) => {
    if (!uri) {
      const selected = await vscode.window.showQuickPick(sessions.open().map(item => ({
        label: sessions.aliases[item.uri] || item.tab.label,
        description: item.group.viewColumn ? `Editor group ${item.group.viewColumn}` : '',
        uri: item.uri,
        viewColumn: item.group.viewColumn
      })), { placeHolder: 'Choose a Codex tab' });
      if (!selected) return;
      uri = selected.uri;
      viewColumn = selected.viewColumn;
    }
    const item = sessions.open().find(tab => tab.uri === uri && (viewColumn == null || tab.group.viewColumn === viewColumn));
    if (!item) return vscode.window.showInformationMessage('This Codex tab is no longer open.');
    await vscode.commands.executeCommand('vscode.openWith', item.tab.input.uri, EDITOR_ID, {
      viewColumn: item.group.viewColumn, preview: false, preserveFocus: false
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codexSessionTabs.renameTab', async item => {
    const uri = item?.uri || sessions.open().find(tab => tab.group.isActive && tab.tab.isActive)?.uri;
    if (!uri) return vscode.window.showInformationMessage('Select a Codex tab first.');
    const label = await vscode.window.showInputBox({
      prompt: 'Name shown in the Codex Sessions list (the official chat title is unchanged)',
      value: sessions.aliases[uri] || item?.label || sessions.open().find(tab => tab.uri === uri)?.tab.label || ''
    });
    if (label === undefined) return;
    await sessions.rename(uri, label.trim());
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codexSessionTabs.reopenSession', async arg => {
    const uri = (typeof arg === 'string' ? arg : arg?.uri) || sessions.visibleRecent()[0]?.uri;
    if (!uri) return vscode.window.showInformationMessage('No resumable Codex conversation has been closed yet.');
    try {
      const parsed = vscode.Uri.parse(uri);
      if (!isResumableUri(parsed)) throw new Error('This entry does not have a resumable Codex session URI.');
      await checkCodexEditor(false);
      replacement.suppress(parsed.toString());
      try {
        await vscode.commands.executeCommand('vscode.openWith', parsed, EDITOR_ID, {
          viewColumn: vscode.ViewColumn.Active, preview: false, preserveFocus: false
        });
      } catch (error) {
        replacement.unsuppress(parsed.toString());
        throw error;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Codex Sessions: Reopen failed: ${error.message}`);
    }
  }));

  const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  button.text = '+ Codex';
  button.tooltip = 'Open a new Codex editor tab';
  button.command = COMMAND_ID;
  button.show();
  context.subscriptions.push(button);
}

module.exports = { activate, checkCodexEditor, newPanelUri, openNewTab, SessionTree, HistoryTabReplacement };
