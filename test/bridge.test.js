'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('SDK history emits bounded JSONL chunks without losing user or assistant messages', () => {
  const script = `
import importlib.util, json, sys, types
stub = types.ModuleType('openai_codex')
stub.ApprovalMode = object
stub.AsyncCodex = object
stub.Sandbox = object
sys.modules['openai_codex'] = stub
spec = importlib.util.spec_from_file_location('codex_bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.REQUEST_ID = 'test-request'
events = []
bridge.emit = lambda kind, **fields: events.append({'requestId': bridge.REQUEST_ID, 'kind': kind, **fields})
def item(kind, **fields):
    return types.SimpleNamespace(root=types.SimpleNamespace(type=kind, **fields))
long_user = '한😀' * 100000
user_content = [types.SimpleNamespace(root=types.SimpleNamespace(type='text', text=long_user))]
items = [item('userMessage', content=user_content)]
items += [item('agentMessage', text=f'assistant {index}') for index in range(300)]
items += [item('commandExecution', command='echo test', aggregated_output='x' * 9000000)]
thread = types.SimpleNamespace(turns=[types.SimpleNamespace(items=items)])
bridge.emit_history(thread)
lines = [json.dumps(event, ensure_ascii=False).encode('utf-8') for event in events]
rows = []
for event in events:
    for part in event['messages']:
        if part['continuation']:
            rows[-1]['text'] += part['text']
        else:
            rows.append({'role': part['role'], 'text': part['text']})
assert len(rows) == 302, len(rows)
assert rows[0] == {'role': 'user', 'text': long_user}
assert [row['text'] for row in rows[1:301]] == [f'assistant {index}' for index in range(300)]
assert rows[-1]['role'] == 'tool' and '[output truncated]' in rows[-1]['text']
assert all(len(line) < 8 * 1024 * 1024 for line in lines)
print(json.dumps({'rows': len(rows), 'chunks': len(events), 'largest_line': max(map(len, lines))}))
`;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const helper = path.join(__dirname, '..', 'py', 'codex_bridge.py');
  const result = spawnSync(python, ['-c', script, helper], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.rows, 302);
  assert.ok(summary.chunks > 1);
  assert.ok(summary.largest_line < 64 * 1024 + 256);
});
