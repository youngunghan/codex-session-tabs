'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  switch (message.type) {
    case 'ready':
    case 'setup':
    case 'history':
    case 'new':
    case 'stop':
      return { type: message.type };
    case 'historyMore':
      return typeof message.cursor === 'string' && message.cursor.length <= 4096
        ? { type: message.type, cursor: message.cursor } : undefined;
    case 'select':
      return typeof message.threadId === 'string' && UUID.test(message.threadId)
        ? { type: message.type, threadId: message.threadId } : undefined;
    case 'send':
      return typeof message.text === 'string' && message.text.trim() && message.text.length <= 100000
        ? { type: message.type, text: message.text } : undefined;
    case 'rename':
      return typeof message.name === 'string' && message.name.trim() && message.name.length <= 200
        ? { type: message.type, name: message.name.trim() } : undefined;
    case 'mode':
      return ['read_only', 'workspace_write'].includes(message.mode)
        ? { type: message.type, mode: message.mode } : undefined;
    default:
      return undefined;
  }
}

function validThreadId(value) {
  return typeof value === 'string' && UUID.test(value);
}

module.exports = { validateMessage, validThreadId };
