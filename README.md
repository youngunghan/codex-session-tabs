# yuhan

Open multiple independent **official Codex** chats in VS Code or Cursor editor tabs. This is a community extension and is not affiliated with OpenAI.

## Use

1. Install the official **Codex** extension (`openai.chatgpt`) and sign in.
2. Install the VSIX with **Extensions → … → Install from VSIX**. For Cursor Remote SSH, install it in the local UI extension host. The official Codex extension must also be available in that window.
3. Run **Codex: New Codex Tab**, click **+ Codex** in the status bar, or press `Ctrl+Alt+N`. Repeat to open more tabs. Drag tabs into separate editor groups if desired.

Each command call passes `openai-codex://route/extension/panel/new` with a unique URI fragment to `vscode.openWith` and the official `chatgpt.conversationEditor`. The unique fragment gives each tab a different document ID. No official extension files are modified. The extension checks that the installed Codex build registers the editor and contains the new-panel route before opening a tab.

## Compatibility

The VSIX contains only JavaScript and can run in VS Code or Cursor on Windows, macOS, and Linux, including Remote SSH windows when installed locally. The minimum declared VS Code API is 1.96.2, matching the locally checked Codex build. Codex's editor route is an internal implementation detail and may change in a future version; the extension reports an error if the installed build no longer exposes it.

On Windows, a VS Code 1.141.1 integration test with official Codex 26.1007.21434 opened two separate `chatgpt.conversationEditor` tabs and verified distinct URIs. An actual Cursor window and macOS/Linux have not yet been visually verified. GitHub CI runs tests on all three operating systems after the repository is pushed.

## Build and test

```sh
npm ci
npm test
npm run test:integration
npm run package
```

`test:integration` uses an installed official Codex extension from the default VS Code/Cursor extensions folder. Set `CODEX_EXTENSION_PATH` to a different installation folder if needed.

Marketplace publishing needs a publisher ID. The `publisher` value remains a development placeholder until one is created.
