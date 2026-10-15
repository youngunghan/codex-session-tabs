'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

delete process.env.ELECTRON_RUN_AS_NODE;

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chat-tabs-'));
  const marker = path.join(directory, 'passed');
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  try {
    await runTests({
      ...(process.env.CODE_EXECUTABLE ? { vscodeExecutablePath: process.env.CODE_EXECUTABLE } : {}),
      ...(process.env.VSCODE_TEST_VERSION ? { version: process.env.VSCODE_TEST_VERSION } : {}),
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'vscode.integration.js'),
      launchArgs: [workspace, '--disable-workspace-trust', '--user-data-dir', path.join(directory, 'user')],
      extensionTestsEnv: { CODEX_TABS_TEST_MARKER: marker }
    });
    if (!fs.existsSync(marker)) throw new Error('VS Code integration marker was not written.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
