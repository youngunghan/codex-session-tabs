# Codex Session Tabs

Open independent Codex chats in VS Code or Cursor editor tabs. **Codex: New Codex Tab** opens the official Codex conversation editor in a new tab; this extension leaves its UI and chat behavior to the official OpenAI Codex extension. An optional SDK chat is also available as **Codex: New SDK Chat Tab**. This community extension is not affiliated with OpenAI.

## Get started

1. Install and sign in to the official OpenAI Codex extension (`openai.chatgpt`) in the same VS Code or Cursor window.
2. Install Codex Session Tabs.
3. Click the Codex toolbar button, run **Codex: New Codex Tab**, or press `Ctrl+Alt+N`. This opens a separate official Codex conversation tab. The official extension controls the composer, model selection, access mode, tools, and conversation history.
4. To use the optional SDK chat, run **Codex: New SDK Chat Tab**. Install Python 3.11–3.13 on the machine or Remote SSH host where this extension runs, then click **Set up Codex SDK** in the new tab. The extension creates a private Python environment in VS Code's extension global storage and installs its pinned `openai-codex` 0.162.1 SDK with the matching runtime. Existing Codex authentication is reused. This SDK environment is separate from the official extension and does not replace or downgrade it. If Python is not on `PATH`, set `codexSessionTabs.pythonPath` to its executable and retry.
5. Send a message in the SDK chat. Its first send stores the returned Codex thread ID in that tab; later messages continue the same thread.

## Official Codex tabs

The default **Codex: New Codex Tab** command, toolbar button, and `Ctrl+Alt+N` open the official extension's `chatgpt.conversationEditor` using its `/extension/panel/new` route with a unique tab identifier. This requires the official `openai.chatgpt` extension to be installed and to provide the expected custom editor and route. If those checks fail, this extension reports an error; it does not silently switch to SDK chat. It does not modify the official extension's files.

The official extension owns its model selector, access and approval modes, tools, and history UI. This wrapper opens new official conversation tabs; it does not guarantee that choosing a saved conversation will stay in the same panel, or that renaming a conversation will update an already-open editor tab title in real time.

Saved conversations opened from the official history can initially be VS Code preview tabs (italic tab titles). Starting in 0.6.2, this extension automatically applies **Keep Editor** to official local/remote conversation previews so that the next history selection keeps the earlier conversation open. You do not need to double-click each history tab. This keeps the existing webview; it does not reopen it, close a source tab, change global preview settings, or change SDK chat records.

This handling runs after the editor-tab event arrives. If the IDE replaces a preview before that event is delivered during exceptionally fast consecutive selections, this extension cannot recover the closed panel or its unsent input. It does not reopen closed tabs. Official history may still open a separate tab rather than changing the current panel; the official extension controls that behavior.

Previous reports of some existing Codex tabs accepting text but hanging after send, and failing to open file links, remain unresolved. The root cause is unknown, and returning to the official editor route is not evidence that the prior issue has been fixed.

## Optional SDK chats

The **Codex: New SDK Chat Tab** command opens this extension's own chat panel and uses the official [`openai-codex` Python SDK](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md) with its matching Codex runtime. It is separate from the official conversation editor and remains available when explicitly requested.

**History** lists up to 50 local SDK threads per page, with **More** for the next page. Selecting a thread changes the conversation in that SDK tab. If another SDK tab in this window already owns the thread, that tab is focused instead. Renaming calls the SDK's thread rename operation and changes this extension's editor tab title. **New SDK Chat Tab** opens another SDK editor tab and leaves the current conversation in place. Existing SDK panel and thread records are retained; official extension conversations and SDK conversations are managed by their respective interfaces.

## SDK access mode and limitations

SDK tabs start in **Read only (local files)** mode with approval requests denied. For coding work, choose **Allow workspace file writes** in a trusted workspace and confirm the prompt. This permits ordinary edits inside the workspace; approval requests remain denied. These modes control local filesystem access; configured external tools, including MCP servers or connectors inherited from Codex configuration, may still be available in either mode. The extension does not currently disable those tools. Each SDK tab stays bound to the folder it opened with, even if multi-root folders are reordered or the window reloads. The choice resets to local-file read only after reload or a thread switch; removing the folder or losing workspace trust also resets it and terminates the active helper process tree. Trust revocation is checked at SDK events and every 250 ms, so edits made before detection cannot be undone. The sandbox and approval mode are applied when a thread starts or resumes and on every turn.

SDK history is local to the extension host. A Remote SSH host, a local desktop, and another computer may have different threads. Threads created in another workspace are shown with their source path; opening one in the current workspace asks for confirmation and resets local file access to read only. A thread active in another Codex client may be locked. The extension reports that condition and does not alter locks. SDK-created threads can be absent from history before their first completed turn; this extension keeps a newly returned ID in the editor tab immediately and does not automatically retry an uncertain first send. Failed and interrupted turn prompts remain recoverable in the composer or an ordered failed-prompt list.

The SDK UI shows text messages, streamed responses, command output, and changed file paths. It does not provide the official Codex UI, interactive approval requests, attachments, cloud conversation history, or every tool interaction. Message content is rendered as text under a restrictive webview Content Security Policy. The SDK implementation does not read Codex rollout files, call app-server JSON-RPC directly, or use private APIs from the official VS Code extension.

## Upgrade from 0.6.0

The default **Codex: New Codex Tab** command now opens the official Codex conversation editor again. The SDK chat remains available through **Codex: New SDK Chat Tab**. Existing SDK panel and thread records are retained; this change does not modify the official extension or claim to fix the earlier send-hang or file-link issue.

## Upgrade from 0.6.1

Version 0.6.2 fixes the normal history-preview replacement flow by keeping official conversation tabs automatically. After installing the update, reload the IDE window when your current work is finished. The default interface remains the official Codex interface.

## Build and test

```sh
npm ci
npm test
npm run test:integration
npm run package
```

`npm test` checks the extension logic without contacting Codex. By default, `test:integration` opens two independent SDK chat tabs in an isolated VS Code test host. If `CODEX_EXTENSION_PATH` points to an installed official Codex extension, the integration test also loads that extension and checks that the default command opens two independent `chatgpt.conversationEditor` tabs. Supplying two existing diagnostic conversation UUIDs in `CODEX_HISTORY_THREAD_IDS` (comma-separated) additionally checks that two history previews become permanent, including back-to-back opens, without duplicate editors or replacing the new tabs. The official-editor check does not send a live chat message or verify same-panel history behavior, live rename synchronization, restart restoration, or resolution of the earlier send-hang issue. CI runs the default SDK integration path unless the official extension path is supplied.

## Open VSX releases for Cursor

Open VSX hosts the extension version that Cursor can discover for updates. Version 0.6.2 was uploaded manually and is [downloadable on Open VSX](https://open-vsx.org/extension/youngunghan/yuhan-codex-session-tabs); it was not published by this workflow. Installing a VSIX locally gives that machine the version immediately, but does not establish that Cursor's marketplace search or automatic update has worked end to end.

For a future release, update `package.json` and its lockfile to the new version, merge the change into `master`, and push a matching `vX.Y.Z` tag. [The release workflow](.github/workflows/release.yml) checks that the tagged commit is on the current `master` branch, the tag matches the package version, and the version is absent from Open VSX. It runs the tests, packages one VSIX, and passes that exact artifact to its publish job. The publish job rechecks `master` ancestry immediately before using [Open VSX trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing) through GitHub Actions OIDC; it stores no Open VSX personal access token. It then checks that the matching Open VSX API version is downloadable. Do not re-push `v0.6.2` to test the workflow; it is an existing published version.

The [namespace ownership request](https://github.com/EclipseFdn/open-vsx.org/issues/14282) is closed, and the Open VSX API reports the `youngunghan` publisher as verified. Version 0.6.2 is verified and downloadable. The publisher account lists a GitHub Actions trusted publisher for `youngunghan.yuhan-codex-session-tabs`: repository `youngunghan/codex-session-tabs`, workflow filename `release.yml`, and environment `open-vsx`. These prerequisites are in place, but the first automated tagged release has not run. Version 0.6.2 was published manually. Cursor's marketplace availability and a later client-side automatic update still need separate end-to-end checks after a future release.

Publisher: `youngunghan`. Extension ID: `youngunghan.yuhan-codex-session-tabs`.
