'use strict';

const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

// Some terminal hosts set this for their own Electron subprocesses. VS Code
// must launch as an editor, not as a plain Node process.
delete process.env.ELECTRON_RUN_AS_NODE;

runTests({
  ...(process.env.CODE_EXECUTABLE ? { vscodeExecutablePath: process.env.CODE_EXECUTABLE } : {}),
  ...(!process.env.CODE_EXECUTABLE && process.env.VSCODE_TEST_VERSION ? { version: process.env.VSCODE_TEST_VERSION } : {}),
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.resolve(__dirname, 'vscode.integration.js'),
  launchArgs: [path.resolve(__dirname, '..'), '--disable-extensions', '--skip-welcome'],
  extensionTestsEnv: { CODEX_TABS_TEST: '1' }
}).catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
