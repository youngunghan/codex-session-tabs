# Codex Session Tabs

Open independent Codex chats in VS Code or Cursor editor tabs. Each tab is a webview owned by this extension. The chat backend is the official [`openai-codex` Python SDK](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md), using its matching Codex runtime. This community extension is not affiliated with OpenAI.

## Get started

1. Install Python 3.11–3.13 and sign in to Codex on the same machine or Remote SSH host where this extension runs. Existing Codex authentication is reused by the SDK.
2. Install this extension. In a Remote SSH window, install it on the remote workspace host.
3. Click the Codex swirl icon in an editor title bar, run **Codex: New Codex Tab**, or press `Ctrl+Alt+N`.
4. In the new tab, click **Set up Codex SDK**. The extension creates a private Python environment in VS Code's extension global storage and installs its pinned `openai-codex` 0.162.1 SDK with the matching runtime. This is separate from the official Codex VS Code/Cursor extension and does not replace or downgrade it. A notification shows progress. If Python is not on `PATH`, set `codexSessionTabs.pythonPath` to its executable and retry.
5. Send a message. The tab stays provisional until this first send; it then keeps the returned Codex thread ID. The first prompt becomes an initial thread name. Further messages continue that thread.

**History** lists up to 50 local threads per page from the SDK, with **More** for the next page. Selecting a thread changes the conversation in that tab. If another tab in this window already owns the thread, that tab is focused instead. Renaming calls the SDK's thread rename operation and immediately changes this extension's editor tab title. **New chat** opens another editor tab and leaves the current conversation in place. Closing or switching a tab closes its SDK client after the current operation.

## Access mode and limitations

Tabs start in **Read only (local files)** mode with approval requests denied. For coding work, choose **Allow workspace file writes** in a trusted workspace and confirm the prompt. This permits ordinary edits inside the workspace; approval requests remain denied. These modes control local filesystem access; configured external tools, including MCP servers or connectors inherited from Codex configuration, may still be available in either mode. The extension does not currently disable those tools. Each tab stays bound to the folder it opened with, even if multi-root folders are reordered or the window reloads. The choice resets to local-file read only after reload or a thread switch; removing the folder or losing workspace trust also resets it and terminates the active helper process tree. Trust revocation is checked at SDK events and every 250 ms, so edits made before detection cannot be undone. The sandbox and approval mode are applied when a thread starts or resumes and on every turn.

History is local to the extension host. A Remote SSH host, a local desktop, and another computer may have different threads. Threads created in another workspace are shown with their source path; opening one in the current workspace asks for confirmation and resets local file access to read only. A thread active in another Codex client may be locked. The extension reports that condition and does not alter locks. SDK-created threads can be absent from history before their first completed turn; this extension keeps a newly returned ID in the editor tab immediately and does not automatically retry an uncertain first send. Failed and interrupted turn prompts remain recoverable in the composer or an ordered failed-prompt list.

The UI shows text messages, streamed responses, command output, and changed file paths. It is intentionally smaller than the official Codex extension UI. It does not handle interactive approval requests, attachments, cloud conversation history, or every tool interaction. Message content is rendered as text under a restrictive webview Content Security Policy. The extension does not read Codex rollout files, call app-server JSON-RPC directly, or use private APIs from the official VS Code extension.

## Upgrade from 0.5.x

The **Codex: New Codex Tab** command now opens this extension's own editor chat instead of the official Codex custom editor. Existing official Codex tabs stay open in the editor, but this version no longer manages their tab replacement, local list labels, or recently closed list. Saved local Codex threads that the SDK can list may be opened from **History** in a new tab. Unsent text in an old official tab is not migrated. The official Codex extension can still be used separately.

## Build and test

```sh
npm ci
npm test
npm run test:integration
npm run package
```

`npm test` checks the webview protocol and tab controller without contacting Codex. `test:integration` opens two independent editor panels in an isolated VS Code test host. A separate Python bridge smoke test can use a sacrificial `CODEX_HOME` to avoid touching personal session state. These checks do not establish full VS Code/Cursor GUI parity or live chat reliability on every host.

Publisher: `youngunghan`. Extension ID: `youngunghan.yuhan-codex-session-tabs`.
