'use strict';

const vscode = require('vscode');

function html(panel, context) {
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.css'));
  const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.js'));
  const csp = `default-src 'none'; style-src ${panel.webview.cspSource}; script-src ${panel.webview.cspSource}; img-src 'none'; connect-src 'none';`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${css}"></head><body><div class="layout">
  <div class="toolbar"><button id="new">New chat</button><button id="historyButton">History</button><button id="rename">Rename thread</button><select id="mode" aria-label="Codex filesystem access"><option value="read_only">Read only</option><option value="workspace_write">Allow workspace writes</option></select></div>
  <div id="status" role="status"></div><div id="renamePane" hidden><form id="renameForm"><label for="renameInput">Codex conversation name</label><input id="renameInput" maxlength="200" required><button type="submit">Save name</button><button id="cancelRename" type="button">Cancel</button></form></div><div id="setupPane"><p>This extension uses the official Codex Python SDK and its matched runtime in a private environment. Python 3.11–3.13 is required. Setup downloads packages on first use.</p><button id="setup">Set up Codex SDK</button></div>
  <div id="messages" aria-live="polite"></div><aside id="failedPromptPane" hidden><strong>Previous prompt was not confirmed</strong><pre id="failedPromptText"></pre><button id="restoreFailedPrompt" type="button">Replace draft with this prompt</button><button id="dismissFailedPrompt" type="button">Dismiss</button></aside><form id="composer"><textarea id="draft" aria-label="Message" placeholder="Ask Codex about your workspace. Ctrl/Cmd+Enter to send."></textarea><button id="send" type="submit">Send</button><button id="stop" type="button">Stop</button></form>
  <aside id="historyPane" hidden><button id="closeHistory">Close history</button><div id="history"></div><button id="more" hidden>More</button></aside></div><script src="${script}"></script></body></html>`;
}

module.exports = { html };
