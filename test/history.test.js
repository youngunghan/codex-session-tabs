'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { displayItems } = require('../src/history');

test('restores user, assistant, command, and file-change items in order', () => {
  const messages = displayItems([{ items: [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Fix the test' }] },
    { id: 'c', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'passed' },
    { id: 'f', type: 'fileChange', changes: [{ kind: 'update', path: 'src/test.js' }] },
    { id: 'a', type: 'agentMessage', text: 'Done' }
  ] }]);
  assert.deepEqual(messages.map(message => [message.id, message.role]), [
    ['u', 'user'], ['c', 'tool'], ['f', 'tool'], ['a', 'assistant']
  ]);
  assert.match(messages[2].text, /src\/test\.js/);
});
