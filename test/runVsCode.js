'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests, runVSCodeCommand, downloadAndUnzipVSCode } = require('@vscode/test-electron');

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

function resolveMacExecutable(expected) {
  if (process.platform !== 'darwin' || fs.existsSync(expected)) return expected;
  // Newer macOS archives can rename the app executable while test-electron
  // still returns the older Contents/MacOS/Electron path.
  const root = path.resolve(expected, '../../../..');
  for (const app of fs.readdirSync(root).filter(name => name.endsWith('.app'))) {
    const bin = path.join(root, app, 'Contents', 'MacOS');
    if (!fs.existsSync(bin)) continue;
    const executable = fs.readdirSync(bin)
      .map(name => path.join(bin, name))
      .find(file => fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111));
    if (executable) return executable;
  }
  throw new Error(`VS Code's macOS executable was not found near ${expected}`);
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
  if (!options.vscodeExecutablePath && process.platform === 'darwin') {
    options.vscodeExecutablePath = resolveMacExecutable(await downloadAndUnzipVSCode(options));
  }
  await runTests({
    ...options,
    extensionDevelopmentPath: [path.resolve(__dirname, '..'), codexPath],
    extensionTestsPath: path.resolve(__dirname, 'vscode.integration.js'),
    launchArgs: [
      path.resolve(__dirname, '..'),
      '--disable-extensions',
      '--skip-welcome',
      ...(process.platform === 'darwin' ? [`--user-data-dir=/tmp/yuhan-vscode-${process.pid}`] : [])
    ],
    extensionTestsEnv: { CODEX_TABS_TEST: '1' }
  });
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
