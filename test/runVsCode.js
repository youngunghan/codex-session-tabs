'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

delete process.env.ELECTRON_RUN_AS_NODE;

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chat-tabs-'));
  const marker = path.join(directory, 'passed');
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  try {
    const options = {
      ...(process.env.CODE_EXECUTABLE ? { vscodeExecutablePath: process.env.CODE_EXECUTABLE } : {}),
      ...(process.env.VSCODE_TEST_VERSION ? { version: process.env.VSCODE_TEST_VERSION } : {})
    };
    if (process.platform === 'darwin' && !options.vscodeExecutablePath) {
      const expected = await downloadAndUnzipVSCode(options);
      if (fs.existsSync(expected)) options.vscodeExecutablePath = expected;
      else {
        const appRoot = path.resolve(expected, '../../../..');
        for (const app of fs.readdirSync(appRoot).filter(name => name.endsWith('.app'))) {
          const bin = path.join(appRoot, app, 'Contents', 'MacOS');
          if (!fs.existsSync(bin)) continue;
          const executable = fs.readdirSync(bin).map(name => path.join(bin, name))
            .find(file => fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111));
          if (executable) { options.vscodeExecutablePath = executable; break; }
        }
        if (!options.vscodeExecutablePath) throw new Error('The downloaded VS Code macOS executable was not found.');
      }
    }
    await runTests({
      ...options,
      extensionDevelopmentPath: process.env.CODEX_EXTENSION_PATH
        ? [path.resolve(__dirname, '..'), process.env.CODEX_EXTENSION_PATH] : path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'vscode.integration.js'),
      launchArgs: [workspace, '--disable-workspace-trust', '--user-data-dir', path.join(directory, 'user')],
      extensionTestsEnv: { CODEX_TABS_TEST_MARKER: marker,
        ...(process.env.CODEX_EXTENSION_PATH ? { CODEX_EXTENSION_PATH: process.env.CODEX_EXTENSION_PATH } : {}) }
    });
    if (!fs.existsSync(marker)) throw new Error('VS Code integration marker was not written.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
