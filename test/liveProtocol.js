'use strict';

const { AppServer } = require('../src/appServer');
const path = require('node:path');

(async () => {
  const api = new AppServer(process.env.CODEX_TEST_SCRIPT
    ? { commandSpec: { command: process.execPath, args: [process.env.CODEX_TEST_SCRIPT, 'app-server', '--listen', 'stdio://'] } }
    : {});
  try {
    await api.start();
    const result = await api.request('thread/list', { limit: 1, sourceKinds: ['cli', 'vscode', 'appServer'] });
    if (!Array.isArray(result?.data)) throw new Error('Unexpected thread/list response');
    const created = await Promise.all([
      api.request('thread/start', { cwd: path.resolve(__dirname, '..'), serviceName: 'codex_session_tabs_test' }),
      api.request('thread/start', { cwd: path.resolve(__dirname, '..'), serviceName: 'codex_session_tabs_test' })
    ]);
    const threadIds = created.map(result => result?.thread?.id);
    if (!threadIds[0] || !threadIds[1] || threadIds[0] === threadIds[1]) throw new Error('Two tabs need distinct thread IDs');
    try {
      if (result.data[0]?.id) {
        const turns = await api.request('thread/turns/list', { threadId: result.data[0].id, limit: 1, sortDirection: 'desc', itemsView: 'full' });
        if (!Array.isArray(turns?.data)) throw new Error('Unexpected thread/turns/list response');
        if (turns.data.some(turn => !Array.isArray(turn.items))) throw new Error('Unexpected turn item shape');
      }
    } finally {
      await Promise.all(threadIds.map(threadId => api.request('thread/delete', { threadId })));
    }
    process.stdout.write('Codex app-server handshake, thread lifecycle, and history read succeeded.\n');
  } finally {
    api.dispose();
  }
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
