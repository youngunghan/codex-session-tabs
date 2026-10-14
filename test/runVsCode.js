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
    const host = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform];
    const builds = fs.readdirSync(root).filter(name => name.startsWith('openai.chatgpt-'));
    const candidates = builds.filter(name => name.includes(`-${host}-`));
    const match = (candidates.length ? candidates : builds).sort((a, b) => {
      const version = name => (name.match(/^openai\.chatgpt-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
      const left = version(a);
      const right = version(b);
      for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] || 0) - (right[i] || 0);
      return a.localeCompare(b);
    }).at(-1);
    if (match) return path.join(root, match);
  }
  return undefined;
}

function findCodexDependencies(codexPath) {
  const codexPackage = JSON.parse(fs.readFileSync(path.join(codexPath, 'package.json'), 'utf8'));
  const root = path.dirname(codexPath);
  return (codexPackage.extensionDependencies || []).map(id => {
    const candidates = fs.readdirSync(root)
      .filter(name => name.startsWith(`${id}-`))
      .map(name => path.join(root, name))
      .filter(candidate => {
        try {
          return JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).version === codexPackage.version;
        } catch {
          return false;
        }
      });
    if (candidates.length !== 1) {
      throw new Error(`Expected one installed ${id} dependency matching Codex ${codexPackage.version}, found ${candidates.length}.`);
    }
    return candidates[0];
  });
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
  const markerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tabs-test-'));
  const markerPath = path.join(markerDirectory, 'passed');
  try {
    await runTests({
      ...options,
      extensionDevelopmentPath: [path.resolve(__dirname, '..'), codexPath, ...findCodexDependencies(codexPath)],
      extensionTestsPath: path.resolve(__dirname, 'vscode.integration.js'),
      launchArgs: [
        path.resolve(__dirname, '..'),
        '--disable-extensions',
        '--skip-welcome',
        ...(process.platform === 'darwin' ? [`--user-data-dir=/tmp/yuhan-vscode-${process.pid}`] : [])
      ],
      extensionTestsEnv: {
        CODEX_TABS_TEST: '1',
        CODEX_TABS_TEST_MARKER: markerPath,
        ...Object.fromEntries(['CODEX_TEST_SESSION_ID', 'CODEX_TEST_SESSION_ID_SECOND', 'CODEX_EXPECT_SESSION_TITLE']
          .filter(name => process.env[name] !== undefined)
          .map(name => [name, process.env[name]]))
      }
    });
    if (!fs.existsSync(markerPath)) throw new Error('Integration assertions did not complete. See the extension host output above.');
  } finally {
    fs.rmSync(markerDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
