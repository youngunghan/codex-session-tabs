'use strict';

const EDITOR_ID = 'chatgpt.conversationEditor';
const RECENT_LIMIT = 20;

function isCodexTab(tab, vscode) {
  const input = tab?.input;
  return input instanceof vscode.TabInputCustom &&
    input.viewType === EDITOR_ID &&
    input.uri.scheme === 'openai-codex' &&
    input.uri.authority === 'route';
}

function openCodexTabs(groups, vscode) {
  return groups.flatMap(group => group.tabs
    .filter(tab => isCodexTab(tab, vscode))
    .map(tab => ({ tab, group, uri: tab.input.uri.toString() })));
}

function isResumableUri(uri) {
  return uri?.scheme === 'openai-codex' &&
    uri.authority === 'route' &&
    /^\/(local|remote)\/[^/]+$/.test(uri.path);
}

function rememberClosed(recent, entry) {
  return [entry, ...recent.filter(item => item.uri !== entry.uri)].slice(0, RECENT_LIMIT);
}

module.exports = { EDITOR_ID, isCodexTab, openCodexTabs, isResumableUri, rememberClosed };
