'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SdkRuntime, abortProcessTree } = require('../src/runtime');

function fakeRuntime(events, exitCode = 0, options = {}) {
  let stdinText = '';
  const runtime = new SdkRuntime({ globalStorageUri: { fsPath: '/storage' }, extensionPath: '/extension' },
    { workspace: { getConfiguration: () => ({ get: () => '' }) } }, (_command, _args, spawnOptions) => {
      options.onSpawn?.(spawnOptions);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.write = chunk => {
        stdinText += chunk;
        if (stdinText.split('\n').filter(Boolean).length === 1) {
          const request = JSON.parse(stdinText.trim());
          queueMicrotask(() => {
            for (const event of events) {
              const bytes = Buffer.from(typeof event === 'string' ? event :
                `${JSON.stringify({ requestId: request.requestId, ...event })}\n`, 'utf8');
              if (options.splitUtf8 && bytes.includes(Buffer.from('한')[0])) {
                const split = bytes.indexOf(Buffer.from('한')[0]);
                child.stdout.emit('data', bytes.subarray(0, split + 1));
                child.stdout.emit('data', bytes.subarray(split + 1));
              } else child.stdout.emit('data', bytes);
            }
            child.emit('close', exitCode);
          });
        }
      };
      child.kill = options.killNoop ? () => {} : () => child.emit('close', 1);
      return child;
    }, child => {
      options.onAbort?.(child);
      child.emit('close', 1);
    });
  runtime.ready = true;
  return runtime;
}

test('bridge accepts one matching terminal event after nonterminal thread and turn events', async () => {
  const seen = [];
  const runtime = fakeRuntime([{ kind: 'thread', threadId: 'id' }, { kind: 'turn', turnId: 'turn' },
    { kind: 'completed', status: 'completed' }]);
  await runtime.run({ op: 'send', text: 'Hello' }, event => seen.push(event.kind)).promise;
  assert.deepEqual(seen, ['thread', 'turn', 'completed']);
});

test('bridge decodes Korean and emoji across UTF-8 byte boundaries and requests Python UTF-8', async () => {
  const seen = [];
  let options;
  const runtime = fakeRuntime([{ kind: 'item', role: 'assistant', text: '한😀' }, { kind: 'completed' }], 0,
    { splitUtf8: true, onSpawn: value => { options = value; } });
  await runtime.run({ op: 'send', text: '한😀' }, event => seen.push(event)).promise;
  assert.equal(seen[0].text, '한😀');
  assert.equal(options.env.PYTHONUTF8, '1');
  assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
});

test('bridge preserves callback errors instead of reporting invalid SDK JSON', async () => {
  const runtime = fakeRuntime([{ kind: 'item', role: 'assistant', text: 'valid JSON' }]);
  await assert.rejects(runtime.run({ op: 'send' }, () => { throw new Error('application consumer failed'); }).promise,
    error => error.message === 'application consumer failed');
});

test('fatal callback and JSON errors win over a later normal exit and ignore later data', async () => {
  const seen = [];
  const callback = fakeRuntime([{ kind: 'item' }, { kind: 'completed' }], 0, { killNoop: true });
  await assert.rejects(callback.run({ op: 'send' }, event => {
    seen.push(event.kind);
    throw new Error('consumer failed');
  }).promise, error => error.message === 'consumer failed');
  assert.deepEqual(seen, ['item']);
  const malformed = fakeRuntime(['not JSON\n', { kind: 'completed' }], 0, { killNoop: true });
  await assert.rejects(malformed.run({ op: 'send' }, () => {}).promise,
    /Invalid Codex SDK response/);
});

test('configured Python executable is restricted to machine settings', () => {
  const config = require('../package.json').contributes.configuration.properties['codexSessionTabs.pythonPath'];
  assert.equal(config.scope, 'machine');
});

test('bridge rejects process exit without a terminal event', async () => {
  const runtime = fakeRuntime([{ kind: 'thread', threadId: 'id' }]);
  await assert.rejects(runtime.run({ op: 'send', text: 'Hello' }, () => {}).promise,
    /without exactly one terminal event/);
});

test('bridge rejects multiple terminal events and SDK crash', async () => {
  const duplicate = fakeRuntime([{ kind: 'completed' }, { kind: 'completed' }]);
  await assert.rejects(duplicate.run({ op: 'send' }, () => {}).promise, /Multiple Codex SDK terminal events/);
  const crash = fakeRuntime([], 1);
  await assert.rejects(crash.run({ op: 'send' }, () => {}).promise, /exited 1/);
});

test('revocation aborts immediately without the cooperative ten-second stop path', async () => {
  let aborts = 0;
  let spawnOptions;
  const runtime = fakeRuntime([], 0, {
    onAbort: () => { aborts++; }, onSpawn: value => { spawnOptions = value; }
  });
  const operation = runtime.run({ op: 'send', text: 'work' }, () => {});
  operation.abort();
  assert.equal(aborts, 1);
  assert.equal(spawnOptions.detached, process.platform !== 'win32');
  await assert.rejects(operation.promise, /exited 1/);
});

test('hard abort targets the Unix process group and Windows process tree', () => {
  const signals = [];
  abortProcessTree({ pid: 123, kill() { throw new Error('single process kill used'); } }, 'darwin',
    () => { throw new Error('taskkill used on Unix'); }, (...args) => { signals.push(args); }, () => '');
  assert.deepEqual(signals, [[-123, 'SIGSTOP'], [-123, 'SIGKILL']]);
  let command;
  abortProcessTree({ pid: 456, kill() { throw new Error('single process kill used'); } }, 'win32',
    (file, args, options) => { command = { file, args, options }; return { on() {} }; });
  assert.equal(command.file, 'taskkill');
  assert.deepEqual(command.args, ['/PID', '456', '/T', '/F']);
  assert.equal(command.options.stdio, 'ignore');
});

test('Unix hard abort prevents a descendant from writing after revocation', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tabs-abort-'));
  const target = path.join(dir, 'late-write');
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(target)}, 'late'), 500)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)`;
  const child = spawn(process.execPath, ['-e', parent], { detached: true });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
    });
    abortProcessTree(child);
    await new Promise(resolve => child.once('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 700));
    await assert.rejects(fs.stat(target), error => error.code === 'ENOENT');
  } finally {
    try { abortProcessTree(child); } catch { /* Already stopped. */ }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Unix hard abort catches descendants that start their own process group', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tabs-setsid-'));
  const target = path.join(dir, 'late-write');
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(target)}, 'escaped'), 500); setInterval(() => {}, 1000)`;
  const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }); process.stdout.write(String(child.pid) + '\\n'); setInterval(() => {}, 1000)`;
  const child = spawn(process.execPath, ['-e', parent], { detached: true });
  let descendantPid;
  try {
    const ready = await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
    });
    descendantPid = Number(String(ready).trim());
    assert.ok(descendantPid > 0);
    abortProcessTree(child);
    await new Promise(resolve => child.once('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 700));
    await assert.rejects(fs.stat(target), error => error.code === 'ENOENT');
    assert.throws(() => process.kill(descendantPid, 0), error => error.code === 'ESRCH');
  } finally {
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already stopped. */ }
    try { abortProcessTree(child); } catch { /* Already stopped. */ }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
