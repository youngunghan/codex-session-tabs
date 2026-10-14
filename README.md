# yuhan

Open several independent Codex conversations as VS Code editor tabs. This is an independent community extension and is not affiliated with OpenAI.

## Requirements

- Desktop VS Code 1.95 or newer on Windows, macOS, or Linux.
- A locally installed Codex CLI available as `codex` on `PATH`, or an absolute path in `codexSessionTabs.executablePath`.
- A Codex login configured on the machine where the workspace runs (`codex login`). For SSH, WSL, or containers, install the CLI and extension on the workspace host.
- A trusted local or remote workspace.

The extension uses the documented Codex app-server protocol and the public VS Code Webview API. It does not patch or call private APIs in the official Codex extension. It ships no native binaries, so the same VSIX can run on supported desktop platforms. The app-server protocol is still described by OpenAI as experimental; a future Codex release may require compatibility changes. Support cannot be guaranteed for every historical or future CLI and VS Code version.

## Use

1. Open a project folder.
2. Run **Codex Session Tabs: New Chat Tab** from the Command Palette. Repeat to create independent tabs.
3. Use **Codex Session Tabs: Open Saved Chat** to reopen a Codex conversation for the active project.
4. Drag tabs into separate editor groups for side-by-side work.

The chat UI supports plain-text prompts and responses, streamed assistant text, command and file-change summaries, one-time command/file-change approval, stop, and restoration of the last 50 turns. Each tab retains its draft across VS Code reloads. Closing a tab does not delete its Codex history. Sessions in the same folder share the same files; this extension does not create Git worktrees.

The protocol lifecycle has been checked locally with Codex CLI 0.153.4 and 0.162.1 on Windows. A VS Code integration check has opened two separate editor tabs on Windows with VS Code 1.95.0 and 1.141.1. The included CI workflow is configured to run unit, editor-tab, and VSIX packaging checks on Windows, macOS, and Linux after this source is pushed to GitHub. Those CI checks have not run yet.

## Current limits

This is an initial test release. It does not yet render Markdown or diffs, upload images, offer model/permission controls, or handle every app-server request type. Unsupported requests return an error or are declined. Test it on noncritical projects before a public Marketplace release. Codex Cloud is not included.

## Build and test

```sh
npm ci
npm test
npm run package
```

Install the generated `.vsix` with **Extensions → … → Install from VSIX…**. To publish, replace the development `publisher` field in `package.json` with your own Marketplace publisher ID, add an icon and repository URL, then use `npx vsce publish` after cross-platform validation.

## Privacy

The extension starts the Codex CLI on the workspace machine and communicates through standard input/output. It has no developer-run server or telemetry. Conversation content and project data are processed by Codex according to the user's Codex configuration. VS Code stores tab state locally for restoration.
