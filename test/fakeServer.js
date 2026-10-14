'use strict';

const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  else if (message.method === 'approval-test') send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-test' } });
  else if (message.id === 900) send({ id: 3, result: message.result });
});
