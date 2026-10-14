'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

const CODEX_EXTENSION_ID = 'openai.chatgpt';
const EDITOR_ID = 'chatgpt.conversationEditor';
const NEW_PANEL_PATH = '/extension/panel/new';
const COMMAND_ID = 'codexSessionTabs.newTab';

async function checkCodexEditor() {
  const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
  if (!extension) throw new Error('Install the official Codex extension (openai.chatgpt) in this VS Code/Cursor window.');

  const editors = extension.packageJSON?.contributes?.customEditors || [];
  if (!editors.some(editor => editor.viewType === EDITOR_ID)) {
    throw new Error(`Installed Codex ${extension.packageJSON?.version || ''} does not register ${EDITOR_ID}.`);
  }

  const main = extension.packageJSON?.main;
  if (typeof main !== 'string' || !main.startsWith('./')) {
    throw new Error('Cannot locate the installed Codex extension entry point.');
  }
  const mainPath = path.resolve(extension.extensionPath, main);
  const relative = path.relative(extension.extensionPath, mainPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Codex extension entry point is outside its installation folder.');
  }
  let bundle;
  try {
    bundle = await fs.readFile(mainPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the installed Codex extension entry point: ${error.message}`);
  }
  if (!bundle.includes(NEW_PANEL_PATH)) {
    throw new Error(`Installed Codex ${extension.packageJSON?.version || ''} does not contain ${NEW_PANEL_PATH}.`);
  }
  return extension;
}

function newPanelUri() {
  // Codex's route URI has no conversation ID. A unique fragment gives every
  // openWith call its own document identity while preserving the route path.
  return vscode.Uri.from({
    scheme: 'openai-codex',
    authority: 'route',
    path: NEW_PANEL_PATH,
    fragment: crypto.randomUUID()
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

function activate(context) {
  const open = async () => {
    try {
      return await openNewTab();
    } catch (error) {
      vscode.window.showErrorMessage(`Codex: New Codex Tab failed: ${error.message}`);
      throw error;
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND_ID, open));

  const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  button.text = '+ Codex';
  button.tooltip = 'Open a new Codex editor tab';
  button.command = COMMAND_ID;
  button.show();
  context.subscriptions.push(button);
}

module.exports = { activate, checkCodexEditor, newPanelUri, openNewTab };
