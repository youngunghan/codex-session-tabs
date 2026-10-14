# Codex Session Tabs

Open multiple independent **official Codex** chats in VS Code or Cursor editor tabs. This is a community extension and is not affiliated with OpenAI.

## Use

1. Install the official **Codex** extension (`openai.chatgpt`) and sign in.
2. In VS Code, install **Codex Session Tabs** by publisher `youngunghan` from the Visual Studio Marketplace. In Cursor, install the VSIX from the [latest GitHub release](https://github.com/youngunghan/codex-session-tabs/releases/latest) using **Extensions > ... > Install from VSIX**. Cursor uses Open VSX rather than the Visual Studio Marketplace, so this extension will not appear in Cursor search until it is separately published there.
3. In a Remote SSH window, install **both Codex Session Tabs and official Codex on the remote workspace host**.
4. Click the sparkle button in an editor title bar, run **Codex: New Codex Tab** from the Command Palette, or press `Ctrl+Alt+N`. Each call opens an independent Codex editor tab. Drag tabs into separate editor groups if desired.

The sparkle button runs this extension's **Codex: New Codex Tab** command. The official **Open Codex Sidebar** command remains available separately. The sparkle uses a built-in VS Code codicon, so the extension does not copy or modify official Codex assets. Codex Session Tabs is an independent community extension, unaffiliated with or endorsed by OpenAI.

When you choose a saved conversation from the official Codex history in a managed tab, the official editor opens a separate history editor tab. This extension pins that history tab, then closes only the originating managed tab after the history tab remains active in the same editor group. It transfers the managed flow to that history URI, so later history selections replace within the same flow. Other managed tabs and tabs in other groups are left alone. The default for `codexSessionTabs.replaceNewTabOnHistoryOpen` is enabled; set it to `false` to keep both tabs. An explicitly reopened conversation from **Codex Sessions** is not treated as a history selection. The official custom editor uses one document identity per conversation URI: if that conversation is already open, VS Code may focus the existing tab without emitting a new-tab event, so this extension leaves the originating tab open. It also leaves tabs open when it cannot establish that exactly one newly opened history tab came from the selection.

This feature reconciles editor tabs through VS Code's public tab API; it does not navigate the existing official webview or preserve its webview identity. It only replaces a managed tab when the history editor appears as one new, distinct, active resumable tab in the same group. The resulting tab stays in that editor group, while its precise position follows the IDE's `workbench.editor.openPositioning` setting; the public tab API does not expose a way to set tab order. If the official editor itself disposes the source tab, this extension adopts the history tab only when VS Code reports that close alongside the opened history tab and the source URI was unique before the change. Within a window, lineage is resolved by unique editor URI and group column, so host wrappers that change between tab events do not break the flow. After reload, history-tab lineage is not restored; if either URI is ambiguous or the active history editor cannot be confirmed in the originating group, the extension leaves tabs open. **Replacing a tab can lose its active conversation and unsent input; copy anything you need before selecting history, or disable replacement first.** A replaced new-chat tab cannot be restored from Recently closed. Tabs opened before this extension tracked them, or directly by the official Codex command, are left alone.

## Sessions list

Open **Codex Sessions** in the Explorer sidebar to see Codex editor tabs across all editor groups. Select an entry to focus its tab. Right-click an entry and choose **Rename List Label** to give it a local name; this changes the sidebar label, not the official Codex conversation title or editor tab title. Labels are saved per workspace while the tab or a recent resumable session is retained. A label for a non-resumable new-chat tab is discarded when that tab closes; labels for recent sessions are discarded when those sessions leave the recent list. The list distinguishes the selected tab from other open tabs. It does not infer whether Codex is working or waiting for approval.

The **Recently closed** section records tabs opened from an existing official Codex conversation URI (`/local/<id>` or `/remote/<id>`). Select one to reopen its URI, or run **Codex Sessions: Reopen Conversation** to reopen the latest one. Tabs opened with **Codex: New Codex Tab** retain their `/extension/panel/new#...` URI after chatting, so they cannot enter this list. On window reload, VS Code may restore those editor tabs, but this extension cannot guarantee that their conversation content is restored. It reads restored tabs and does not recreate chats from its own records. Reopening a saved URI depends on the official Codex extension continuing to support that route.

If you installed a 0.2.0 or 0.2.1 VSIX, uninstall its `local-development.yuhan-codex-session-tabs` extension before installing this release. The publisher change creates a different extension ID, and keeping both versions would duplicate the command and toolbar button.

Each command call passes `openai-codex://route/extension/panel/new` with a unique URI fragment to `vscode.openWith` and the official `chatgpt.conversationEditor`. The unique fragment gives each tab a different document ID. No official extension files are modified. The extension checks that the installed Codex build registers the editor and contains the new-panel route before opening a tab.

## If a tab stops sending

In a Windows VS Code check on 2026-10-14 with Codex Session Tabs 0.4.1 and official Codex 26.1007.21434, some existing tabs accepted typing but left the message in the composer with a spinning send indicator. File links in those tabs also failed to switch editors. A fresh tab created by the same extension successfully sent a diagnostic message and received a reply. Opening the affected saved conversation from that fresh tab's history created a titled editor where the same file link worked. That reopened saved conversation also successfully sent one diagnostic message and received a reply.

If this happens, copy the unsent text somewhere safe before choosing history; with the default setting, choosing a saved conversation can replace and close the managed source tab. You can set `codexSessionTabs.replaceNewTabOnHistoryOpen` to `false` before selecting history if you want both tabs to remain open. Check the saved conversation's latest messages before resending to avoid sending a request twice. Confirm that it accepts a short diagnostic message before continuing work. This recovery worked for the session tested above; the cause and recurrence conditions remain unknown. These observations do not establish whether this extension or official Codex causes the failure.

## Compatibility

The VSIX contains JavaScript and runs in desktop VS Code on Windows, macOS, and Linux. Its declared minimum is VS Code 1.96.2. GitHub CI tests all three operating systems with VS Code 1.96.2 and the current stable version, including opening two separate official Codex tabs and retaining a pre-existing tab. The sessions list and recent-record logic have unit tests; history replacement is tested in isolated VS Code integration runs using a saved local conversation when `CODEX_TEST_SESSION_ID` is provided. Set `CODEX_EXPECT_SESSION_TITLE=1` when the isolated host is signed in and can resolve that session's title. Set `CODEX_TEST_SESSION_ID_SECOND` to a different saved conversation ID to exercise chained history replacement. The integration test restores the prior global setting after it runs. These tests do not cover message sending, file-link navigation, clicking the official history UI itself, or conversation restoration after reload, and do not prove compatibility with every historical or future Codex version.

Codex's editor route is an internal implementation detail and may change. The extension reports an error if the installed build no longer exposes the expected editor or route. A session's working, completed, and approval-pending states are not exposed through the stable VS Code tab API, so this extension does not claim to show them. Prior Windows Cursor UI checks used version 0.3.1 and observed that two **Codex: New Codex Tab** command calls opened separate editor tabs and **Codex Sessions** showed **Open tabs (2)**. The local Cursor editor webview stayed blank, including a tab opened with the official **Codex: New Codex Agent** command. In a Cursor Remote SSH window connected to Ubuntu host `SN_introai4_39`, two separate tabs and **Open tabs (2)** were visible, and the official Codex input rendered. Actual chat exchange, session restoration after reload, and approval or working status were not visually verified. A live VS Code check confirmed that choosing a saved conversation in the official history UI opens a separate history editor; isolated integration coverage exercises the tab reconciliation using saved conversation URIs, not the official webview click itself.

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
