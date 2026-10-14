'use strict';

function displayItems(turns) {
  const messages = [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        if (text) messages.push({ id: item.id, role: 'user', text });
      } else if (item.type === 'agentMessage' && item.text) {
        messages.push({ id: item.id, role: 'assistant', text: item.text });
      } else if (item.type === 'commandExecution') {
        const output = String(item.aggregatedOutput || '');
        const bounded = output.length > 20000 ? `${output.slice(0, 20000)}\n… output truncated` : output;
        messages.push({ id: item.id, role: 'tool', text: `${item.command || 'Command'}\n${bounded}`.trim() });
      } else if (item.type === 'fileChange') {
        const files = (item.changes || []).map(change => `${change.kind || 'edit'} ${change.path}`).join('\n');
        messages.push({ id: item.id, role: 'tool', text: files || 'File changes' });
      }
    }
  }
  return messages;
}

module.exports = { displayItems };
