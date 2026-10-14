# Codex Session Tabs

Open multiple independent **official Codex** chats in VS Code or Cursor editor tabs. This is a community extension and is not affiliated with OpenAI.

## Use

1. Install the official **Codex** extension (`openai.chatgpt`) and sign in.
2. In VS Code, install **Codex Session Tabs** by publisher `youngunghan` from the Visual Studio Marketplace. In Cursor, install the VSIX from the [latest GitHub release](https://github.com/youngunghan/codex-session-tabs/releases/latest) using **Extensions > ... > Install from VSIX**. Cursor uses Open VSX rather than the Visual Studio Marketplace, so this extension will not appear in Cursor search until it is separately published there.
3. In a Remote SSH window, install **both Codex Session Tabs and official Codex on the remote workspace host**.
4. Run **Codex: New Codex Tab**, click **+ Codex** in the status bar or the **+** button (**Codex: New Codex Tab**) in any editor title bar, or press `Ctrl+Alt+N`. Each call opens a new editor tab directly. Drag tabs into separate editor groups if desired.

The official Codex logo button still runs **Open Codex Sidebar**. This extension adds its own **+** button; it does not override the official command. To keep only the tab button, right-click the editor toolbar and hide **Open Codex Sidebar** if your IDE offers that menu option.

When you select a saved conversation from the official Codex history, it opens as a separate editor tab. The official Codex editor supplies its conversation title. The active **+ Codex** tab stays open by default, protecting any ongoing conversation or unsent input. To close that tab automatically when a saved conversation opens, opt in to `codexSessionTabs.replaceNewTabOnHistoryOpen`. This also applies when another command opens a saved conversation while the new tab is active. **An active conversation or unsent input in the closed tab may be lost; this extension cannot restore that tab from Recently closed.** Tabs opened by older versions or by the official Codex command are left alone.

## Sessions list

Open **Codex Sessions** in the Explorer sidebar to see Codex editor tabs across all editor groups. Select an entry to focus its tab. Right-click an entry and choose **Rename List Label** to give it a local name; this changes the sidebar label, not the official Codex conversation title or editor tab title. List labels are saved per workspace. The list distinguishes the selected tab from other open tabs. It does not infer whether Codex is working or waiting for approval.

The **Recently closed** section records tabs opened from an existing official Codex conversation URI (`/local/<id>` or `/remote/<id>`). Select one to reopen its URI, or run **Codex Sessions: Reopen Conversation** to reopen the latest one. Tabs opened with **+ Codex** retain their `/extension/panel/new#...` URI after chatting, so they cannot enter this list. On window reload, VS Code may restore those editor tabs, but this extension cannot guarantee that their conversation content is restored. It reads restored tabs and does not recreate chats from its own records. Reopening a saved URI depends on the official Codex extension continuing to support that route.

If you installed a 0.2.0 or 0.2.1 VSIX, uninstall its `local-development.yuhan-codex-session-tabs` extension before installing this release. The publisher change creates a different extension ID, and keeping both versions would duplicate the command and status button.

Each command call passes `openai-codex://route/extension/panel/new` with a unique URI fragment to `vscode.openWith` and the official `chatgpt.conversationEditor`. The unique fragment gives each tab a different document ID. No official extension files are modified. The extension checks that the installed Codex build registers the editor and contains the new-panel route before opening a tab.

## If a tab stops sending

In a Windows VS Code check on 2026-10-14 with Codex Session Tabs 0.4.1 and official Codex 26.1007.21434, some existing tabs accepted typing but left the message in the composer with a spinning send indicator. File links in those tabs also failed to switch editors. A fresh tab created by the same extension successfully sent a diagnostic message and received a reply. Opening the affected saved conversation from that fresh tab's history created a titled editor where the same file link worked. That reopened saved conversation also successfully sent one diagnostic message and received a reply.

If this happens, preserve your unsent text, open **+ Codex**, and select the saved conversation from that new tab's history. Check its latest messages before resending to avoid sending a request twice. Confirm that the reopened session accepts a short diagnostic message before continuing work. Keep the original tab until its draft is safely copied. This recovery worked for the session tested above; the cause and recurrence conditions remain unknown. These observations do not establish whether this extension or official Codex causes the failure.

## Compatibility

The VSIX contains only JavaScript and runs in desktop VS Code on Windows, macOS, and Linux. Its declared minimum is VS Code 1.96.2. GitHub CI tests all three operating systems with VS Code 1.96.2 and the current stable version, including opening two separate official Codex tabs and retaining a pre-existing tab. The sessions list and recent-record logic have unit tests; reopening an existing local conversation URI was tested in VS Code and Cursor on Windows, but that path is not exercised in CI. CI installs a compatible official Codex build from the Marketplace. These tests do not cover message sending, file-link navigation, or conversation restoration after reload, and do not prove compatibility with every historical or future Codex version.

Codex's editor route is an internal implementation detail and may change. The extension reports an error if the installed build no longer exposes the expected editor or route. A session's working, completed, and approval-pending states are not exposed through the stable VS Code tab API, so this extension does not claim to show them. In Windows Cursor UI checks for 0.3.1, two clicks on **+ Codex** opened two separate editor tabs and **Codex Sessions** showed **Open tabs (2)**. The local Cursor editor webview stayed blank, including a tab opened with the official **Codex: New Codex Agent** command. In a Cursor Remote SSH window connected to Ubuntu host `SN_introai4_39`, two separate tabs and **Open tabs (2)** were visible, and the official Codex input rendered. Actual chat exchange, session restoration after reload, and approval or working status were not visually verified. The 0.4.0 history replacement was verified in isolated VS Code and Cursor integration tests using a saved local conversation; direct clicking in the official history popup was not visually tested.

## Updates

VS Code installs updates automatically for enabled extensions installed from its Marketplace when extension auto-update is enabled. VS Code disables auto-update by default for extensions installed from a VSIX. This extension is distributed to Cursor as a VSIX, so install each new GitHub release manually in Cursor and Remote SSH. The extension does not contain its own updater.

## Build and test

```sh
npm ci
npm test
npm run test:integration
npm run package
```

Building requires Node.js 22 or newer. `test:integration` uses an installed official Codex extension from the default VS Code/Cursor extensions folder, or installs one from the Marketplace if none is found. Set `CODEX_EXTENSION_PATH` to a specific installation folder if needed.

Publisher: `youngunghan`. Extension ID: `youngunghan.yuhan-codex-session-tabs`.
