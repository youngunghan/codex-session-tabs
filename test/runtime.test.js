'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { SdkRuntime } = require('../src/runtime');

function fakeRuntime(events, exitCode = 0) {
  let stdinText = '';
  const runtime = new SdkRuntime({ globalStorageUri: { fsPath: '/storage' }, extensionPath: '/extension' },
    { workspace: { getConfiguration: () => ({ get: () => '' }) } }, () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.write = chunk => {
        stdinText += chunk;
        if (stdinText.split('\n').filter(Boolean).length === 1) {
          const request = JSON.parse(stdinText.trim());
          queueMicrotask(() => {
            for (const event of events) child.stdout.emit('data', `${JSON.stringify({ requestId: request.requestId, ...event })}\n`);
            child.emit('close', exitCode);
          });
        }
      };
      child.kill = () => child.emit('close', 1);
      return child;
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
