# yuhan

Open multiple independent **official Codex** chats in VS Code or Cursor editor tabs. This is a community extension and is not affiliated with OpenAI.

## Use

1. Install the official **Codex** extension (`openai.chatgpt`) and sign in.
2. In VS Code, install **yuhan** by publisher `youngunghan` from the Visual Studio Marketplace. In Cursor, install the VSIX from the [GitHub release](https://github.com/youngunghan/yuhan-codex-session-tabs/releases/tag/v0.2.2) using **Extensions > ... > Install from VSIX**. Cursor uses Open VSX rather than the Visual Studio Marketplace, so this extension will not appear in Cursor search until it is separately published there.
3. In a Remote SSH window, install **both yuhan and official Codex on the remote workspace host**.
4. Run **Codex: New Codex Tab**, click **+ Codex** in the status bar, or press `Ctrl+Alt+N`. Repeat to open more tabs. Drag tabs into separate editor groups if desired.

If you installed a 0.2.0 or 0.2.1 VSIX, uninstall its `local-development.yuhan-codex-session-tabs` extension before installing this release. The publisher change creates a different extension ID, and keeping both versions would duplicate the command and status button.

Each command call passes `openai-codex://route/extension/panel/new` with a unique URI fragment to `vscode.openWith` and the official `chatgpt.conversationEditor`. The unique fragment gives each tab a different document ID. No official extension files are modified. The extension checks that the installed Codex build registers the editor and contains the new-panel route before opening a tab.

## Compatibility

The VSIX contains only JavaScript and runs in desktop VS Code on Windows, macOS, and Linux. Its declared minimum is VS Code 1.96.2. GitHub CI tests all three operating systems with VS Code 1.96.2 and the current stable version, including opening two separate official Codex tabs and retaining a pre-existing tab. CI installs a compatible official Codex build from the Marketplace. These tests do not prove compatibility with every historical or future Codex version.

Codex's editor route is an internal implementation detail and may change. The extension reports an error if the installed build no longer exposes the expected editor or route. An actual Cursor window and Remote SSH session have not yet been directly tested.

## Build and test

```sh
npm ci
npm test
npm run test:integration
npm run package
```

Building requires Node.js 22 or newer. `test:integration` uses an installed official Codex extension from the default VS Code/Cursor extensions folder, or installs one from the Marketplace if none is found. Set `CODEX_EXTENSION_PATH` to a specific installation folder if needed.

Publisher: `youngunghan`. Extension ID: `youngunghan.yuhan-codex-session-tabs`.
