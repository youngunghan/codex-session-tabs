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
const HISTORY_STABILITY_MS = 150;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
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
    this.managedUris = new Set();
    this.knownUris = this.snapshotUris();
    this.changeQueue = Promise.resolve();
  }

  snapshotUris() {
    const groups = this.api.window.tabGroups.all || [];
    const activeGroup = this.api.window.tabGroups.activeTabGroup;
    const allGroups = activeGroup && !groups.includes(activeGroup) ? [...groups, activeGroup] : groups;
    return openCodexTabs(allGroups, this.api).map(entry => entry.uri);
  }

  active() {
    const group = this.api.window.tabGroups.activeTabGroup;
    return group?.activeTab ? { group, tab: group.activeTab } : undefined;
  }

  syncActive() {
    this.previousActive = this.active();
  }

  tabUri(tab) {
    return tab?.input?.uri?.toString();
  }

  sameGroup(left, right) {
    return !!left && !!right && (left === right ||
      (left.viewColumn != null && right.viewColumn != null && left.viewColumn === right.viewColumn));
  }

  groups() {
    const groups = this.api.window.tabGroups.all || [];
    const active = this.api.window.tabGroups.activeTabGroup;
    return active && !groups.some(group => this.sameGroup(group, active)) ? [...groups, active] : groups;
  }

  tabsForUri(uri) {
    return this.groups().flatMap(group =>
      group.tabs.filter(tab => this.tabUri(tab) === uri).map(tab => ({ group, tab })));
  }

  tabInGroup(group, uri) {
    const resolvedGroup = this.groups().find(candidate => this.sameGroup(candidate, group)) || group;
    const matches = resolvedGroup?.tabs?.filter(tab => this.tabUri(tab) === uri) || [];
    return matches.length === 1 ? matches[0] : undefined;
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

  isManaged(tab) {
    return isCodexTab(tab, this.api) &&
      (isManagedNewUri(tab.input.uri) || this.managedUris.has(this.tabUri(tab)));
  }

  isStableTarget(pending) {
    const active = this.active();
    const currentTarget = this.tabInGroup(pending.group, pending.historyUri);
    return this.pending === pending && this.tabUri(active?.tab) === pending.historyUri &&
      this.sameGroup(active.group, pending.group) && !!currentTarget &&
      this.tabsForUri(pending.historyUri).length === 1 &&
      !currentTarget.isPreview &&
      (pending.sourceDisposed || (this.tabsForUri(pending.originalUri).length === 1 &&
        this.sameGroup(this.tabsForUri(pending.originalUri)[0].group, pending.group))) &&
      Date.now() - pending.at < REPLACEMENT_WINDOW_MS;
  }

  onTabsChanged(event) {
    const observation = {
      opened: [...(event.opened || [])],
      closed: [...(event.closed || [])],
      previous: this.previousActive,
      previouslyKnownUris: this.knownUris,
      current: this.active()
    };
    this.previousActive = observation.current;
    this.knownUris = this.snapshotUris();
    const process = () => this.processTabsChanged(observation);
    const result = this.changeQueue.then(process, process);
    this.changeQueue = result.catch(error => {
      console.error('Codex Sessions: failed to process tab change', error);
    });
    return result;
  }

  async processTabsChanged(observation) {
    const opened = observation.opened;
    const previous = observation.previous;
    const previousWasManaged = this.isManaged(previous?.tab);
    const closed = observation.closed;
    const previouslyKnownUris = observation.previouslyKnownUris;
    const current = observation.current;
    for (const tab of closed) {
      const uri = this.tabUri(tab);
      if (uri && this.managedUris.has(uri) && !this.tabsForUri(uri).length) this.managedUris.delete(uri);
    }
    const openedHistories = opened.filter(tab =>
      isCodexTab(tab, this.api) && isResumableUri(tab.input.uri) &&
      !previouslyKnownUris.includes(tab.input.uri.toString()));
    const openedHistory = openedHistories.length === 1 ? openedHistories[0] : undefined;
    const historyUri = openedHistory?.input.uri.toString();
    const suppressed = historyUri && this.suppressed.has(historyUri);
    if (suppressed) this.unsuppress(historyUri);
    const enabled = this.api.workspace?.getConfiguration?.('codexSessionTabs')
      ?.get('replaceNewTabOnHistoryOpen', true) ?? true;
    const previousUri = this.tabUri(previous?.tab);
    const sourceDisposed = !!previousUri && closed.some(tab => this.tabUri(tab) === previousUri) &&
      previouslyKnownUris.filter(uri => uri === previousUri).length === 1 &&
      !this.tabInGroup(previous.group, previousUri);
    const sameGroupHistory = !!previous && !!openedHistory &&
        historyUri !== previousUri && this.sameGroup(current?.group, previous.group) &&
        this.tabsForUri(historyUri).length === 1 &&
        this.sameGroup(this.groups().find(group =>
          group.tabs.some(tab => this.tabUri(tab) === historyUri)), previous.group);
    if (enabled && !suppressed && openedHistory && previous && previousWasManaged &&
        sameGroupHistory &&
        (sourceDisposed || !!this.tabInGroup(previous.group, previousUri)) &&
        (sourceDisposed || this.tabUri(current?.tab) === previousUri || this.tabUri(current?.tab) === historyUri)) {
      this.pending = {
        original: previous.tab,
        originalUri: previousUri,
        history: openedHistory,
        group: previous.group,
        sourceDisposed,
        historyUri,
        at: Date.now()
      };
    }

    const pending = this.pending;
    const shouldReplace = pending && !pending.processing && this.tabUri(current?.tab) === pending.historyUri &&
      this.sameGroup(current.group, pending.group) &&
      (pending.sourceDisposed || (this.tabsForUri(pending.originalUri).length === 1 &&
        this.sameGroup(this.tabsForUri(pending.originalUri)[0].group, pending.group))) &&
      !!this.tabInGroup(pending.group, pending.historyUri) &&
      this.tabsForUri(pending.historyUri).length === 1 &&
      Date.now() - pending.at < REPLACEMENT_WINDOW_MS;
    let attemptedPin = false;
    if (shouldReplace) {
      pending.processing = true;
      await wait(HISTORY_STABILITY_MS);
      const activeBeforePin = this.active();
      const targetBeforePin = this.tabInGroup(pending.group, pending.historyUri);
      if (this.pending === pending && this.tabUri(activeBeforePin?.tab) === pending.historyUri &&
          this.sameGroup(activeBeforePin.group, pending.group) && targetBeforePin?.isPreview) {
        // Pin only after independent activation, then allow the host's editor
        // transition to settle before closing its source.
        attemptedPin = true;
        const pinnedHistory = await this.keepHistoryTabOpen(pending.history);
        if (pinnedHistory) pending.history = pinnedHistory;
        await wait(HISTORY_STABILITY_MS);
      }
      const stable = this.isStableTarget(pending);
      if (stable) {
        this.pending = undefined;
        // The official editor may either open a second tab or dispose its
        // source while routing to history. Adopt a disposed source only when
        // the same tab event reports that close alongside this exact history.
        this.managedUris.add(pending.historyUri);
        if (!pending.sourceDisposed) {
          try {
            const sources = this.tabsForUri(pending.originalUri);
            if (sources.length !== 1 || !this.sameGroup(sources[0].group, pending.group)) {
              this.managedUris.delete(pending.historyUri);
              return;
            }
            await this.api.window.tabGroups.close(sources[0].tab, true);
          } catch (error) {
            this.managedUris.delete(pending.historyUri);
            console.error('Codex Sessions: failed to replace the new tab', error);
          }
        }
      } else if (this.pending === pending) {
        pending.processing = false;
      }
    } else if (pending && (Date.now() - pending.at >= REPLACEMENT_WINDOW_MS ||
        (!pending.sourceDisposed && this.tabUri(current?.tab) !== pending.originalUri && this.tabUri(current?.tab) !== pending.historyUri))) {
      this.pending = undefined;
    }
    const activeTab = this.active()?.tab;
    if (!attemptedPin && activeTab?.isPreview && isCodexTab(activeTab, this.api) && isResumableUri(activeTab.input.uri)) {
      await this.keepHistoryTabOpen(activeTab);
    }
  }

  async keepHistoryTabOpen(tab) {
    const historyUri = this.tabUri(tab);
    const initialMatches = this.tabsForUri(historyUri);
    if (initialMatches.length !== 1) return undefined;
    const group = initialMatches[0].group;
    const initialTarget = initialMatches[0].tab;
    if (!initialTarget.isPreview) return initialTarget;
    const active = this.active();
    if (!this.sameGroup(active?.group, group) || this.tabUri(active?.tab) !== historyUri) return undefined;
    const pinnedTarget = () => {
      const matches = this.tabsForUri(historyUri);
      const activeNow = this.active();
      return matches.length === 1 && !matches[0].tab.isPreview &&
        this.sameGroup(activeNow?.group, matches[0].group) && this.tabUri(activeNow?.tab) === historyUri
        ? matches[0].tab : undefined;
    };
    try {
      await this.api.commands.executeCommand('workbench.action.keepEditor');
    } catch (error) {
      console.error('Codex Sessions: failed to pin the active history tab', error);
    }
    const afterKeep = pinnedTarget();
    if (afterKeep) return afterKeep;

    // Some custom-editor hosts do not pin with keepEditor; reopen the exact URI
    // as a non-preview editor only while that unique history URI remains active.
    const activeAfterPin = this.active();
    const activeUri = this.tabUri(activeAfterPin?.tab);
    if (!this.sameGroup(activeAfterPin?.group, group) || activeUri !== historyUri ||
        this.tabsForUri(historyUri).length !== 1) return undefined;
    try {
      await this.api.commands.executeCommand('vscode.openWith', initialTarget.input.uri, EDITOR_ID, {
        viewColumn: group.viewColumn,
        preview: false,
        preserveFocus: false
      });
    } catch (error) {
      console.error('Codex Sessions: failed to reopen history as a pinned tab', error);
    }
    return pinnedTarget();
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
      const alreadyOpen = openCodexTabs(vscode.window.tabGroups.all, vscode)
        .some(entry => entry.uri === parsed.toString());
      replacement.unsuppress(parsed.toString());
      if (!alreadyOpen) {
        replacement.managedUris.delete(parsed.toString());
        replacement.suppress(parsed.toString());
      }
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

}

module.exports = { activate, checkCodexEditor, newPanelUri, openNewTab, SessionTree, HistoryTabReplacement };
