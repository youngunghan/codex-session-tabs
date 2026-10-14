'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests, runVSCodeCommand } = require('@vscode/test-electron');

delete process.env.ELECTRON_RUN_AS_NODE;

function findCodexExtension() {
  if (process.env.CODEX_EXTENSION_PATH) return process.env.CODEX_EXTENSION_PATH;
  const roots = [
    path.resolve(__dirname, '..', '.vscode-test', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const match = fs.readdirSync(root).filter(name => name.startsWith('openai.chatgpt-')).sort().at(-1);
    if (match) return path.join(root, match);
  }
  return undefined;
}

async function main() {
  const options = {
    ...(process.env.CODE_EXECUTABLE ? { vscodeExecutablePath: process.env.CODE_EXECUTABLE } : {}),
    ...(!process.env.CODE_EXECUTABLE && process.env.VSCODE_TEST_VERSION ? { version: process.env.VSCODE_TEST_VERSION } : {})
  };
  let codexPath = findCodexExtension();
  if (!codexPath) {
    await runVSCodeCommand(['--install-extension', 'openai.chatgpt', '--force'], options);
    codexPath = findCodexExtension();
  }
  if (!codexPath) throw new Error('Could not find the installed official Codex extension. Set CODEX_EXTENSION_PATH.');
  await runTests({
    ...options,
    extensionDevelopmentPath: [path.resolve(__dirname, '..'), codexPath],
    extensionTestsPath: path.resolve(__dirname, 'vscode.integration.js'),
    launchArgs: [path.resolve(__dirname, '..'), '--disable-extensions', '--skip-welcome'],
    extensionTestsEnv: { CODEX_TABS_TEST: '1' }
  });
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
