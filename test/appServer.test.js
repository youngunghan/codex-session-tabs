'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppServer, executableCommand } = require('../src/appServer');

test('resolves a native Codex executable from PATH', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tabs-'));
  try {
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const executable = path.join(folder, name);
    fs.writeFileSync(executable, '');
    const result = executableCommand('', { PATH: folder });
    assert.equal(result.command, executable);
    assert.deepEqual(result.args, ['app-server', '--listen', 'stdio://']);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('resolves the npm Codex launcher on Windows without a shell', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tabs-npm-'));
  try {
    const launcher = path.join(folder, 'codex.cmd');
    const script = path.join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(launcher, '');
    fs.writeFileSync(script, '');
    const result = executableCommand(launcher, process.env, 'win32');
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, [script, 'app-server', '--listen', 'stdio://']);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('initializes, correlates requests, and routes server requests', async () => {
  const fake = path.join(__dirname, 'fakeServer.js');
  const api = new AppServer({ commandSpec: { command: process.execPath, args: [fake] } });
  try {
    api.on('serverRequest', request => api.respond(request.id, { decision: 'decline' }));
    await api.start();
    const result = await api.request('thread/start', { cwd: process.cwd() });
    assert.equal(result.thread.id, 'thread-test');
    const response = await api.request('approval-test');
    assert.equal(response.decision, 'decline');
  } finally { api.dispose(); }
});
