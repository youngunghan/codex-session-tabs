'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
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

test('SDK bridge carries failed and interrupted terminal turn statuses', () => {
  const script = `
import asyncio, importlib.util, json, sys, types
stub = types.ModuleType('openai_codex')
stub.ApprovalMode = object
stub.AsyncCodex = object
stub.Sandbox = object
sys.modules['openai_codex'] = stub
spec = importlib.util.spec_from_file_location('codex_bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.REQUEST_ID = 'test-request'
bridge.settings = lambda request: (None, None)
bridge.watch_stop = lambda turn: asyncio.Event()
events = []
bridge.emit = lambda kind, **fields: events.append({'kind': kind, **fields})
class Turn:
    id = 'turn-1'
    def __init__(self, status): self.status = status
    async def stream(self):
        yield types.SimpleNamespace(method='turn/completed', payload=types.SimpleNamespace(
            turn=types.SimpleNamespace(status=types.SimpleNamespace(value=self.status))))
class Thread:
    id = 'thread-1'
    def __init__(self, status): self.status = status
    async def set_name(self, name): pass
    async def turn(self, text, **kwargs): return Turn(self.status)
class Codex:
    def __init__(self, status): self.status = status
    async def thread_start(self, **kwargs): return Thread(self.status)
async def check(status):
    events.clear()
    await bridge.send(Codex(status), {'text': 'retain this', 'mode': 'read_only'})
    assert [event['kind'] for event in events] == ['thread', 'turn', 'completed'], events
    assert events[-1]['status'] == status, events
for status in ('failed', 'interrupted'):
    asyncio.run(check(status))
print('statuses=failed,interrupted')
`;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const helper = path.join(__dirname, '..', 'py', 'codex_bridge.py');
  const result = spawnSync(python, ['-c', script, helper], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'statuses=failed,interrupted');
});

test('early Stop retries until active while late Stop exits without interrupting a completed turn', () => {
  const script = `
import asyncio, importlib.util, io, json, sys, types
stub = types.ModuleType('openai_codex')
stub.ApprovalMode = object
stub.AsyncCodex = object
stub.Sandbox = object
sys.modules['openai_codex'] = stub
spec = importlib.util.spec_from_file_location('codex_bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
events = []
bridge.emit = lambda kind, **fields: events.append(kind)
bridge.abort_on_parent_eof = lambda: None
class EarlyTurn:
    attempts = 0
    async def interrupt(self):
        self.attempts += 1
        if self.attempts == 1: raise RuntimeError('no active turn to interrupt')
class LateTurn:
    attempts = 0
    async def interrupt(self): self.attempts += 1
async def check_early():
    original = sys.stdin
    sys.stdin = io.StringIO('{' + '"op":"stop"' + '}\\n')
    try:
        turn = EarlyTurn()
        done = bridge.watch_stop(turn)
        await asyncio.sleep(0.35)
        done.set()
        assert turn.attempts >= 2, turn.attempts
        assert events == ['stopping'], events
    finally: sys.stdin = original
async def check_late():
    events.clear()
    original = sys.stdin
    sys.stdin = io.StringIO('{' + '"op":"stop"' + '}\\n')
    try:
        turn = LateTurn()
        done = bridge.watch_stop(turn)
        done.set()
        await asyncio.sleep(0.05)
        assert turn.attempts == 0, turn.attempts
        assert events == ['stopIgnored'], events
    finally: sys.stdin = original
asyncio.run(check_early())
asyncio.run(check_late())
print('early=retry late=ignored')
`;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const helper = path.join(__dirname, '..', 'py', 'codex_bridge.py');
  const result = spawnSync(python, ['-c', script, helper], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'early=retry late=ignored');
});

test('stdin EOF aborts an active turn and its detached SDK descendant', { skip: process.platform === 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-bridge-eof-'));
  const sentinel = path.join(directory, 'late.txt');
  const delayedWrite = `import time,pathlib;time.sleep(.5);pathlib.Path(${JSON.stringify(sentinel)}).write_text('late')`;
  const stub = `import asyncio, os, subprocess, sys\n` +
    `class Mode:\n    read_only='read_only'\n    workspace_write='workspace_write'\n    deny_all='deny_all'\n` +
    `Sandbox=ApprovalMode=Mode\n` +
    `class Turn:\n    id='turn-1'\n    async def stream(self):\n        await asyncio.sleep(2)\n        yield type('E', (), {'method':'turn/completed','payload':type('P', (), {'turn':type('T', (), {'status':type('S', (), {'value':'completed'})()})()})()})()\n` +
    `class Thread:\n    id='0199ab00-0000-7000-8000-000000000001'\n    async def set_name(self, name): pass\n    async def turn(self, text, **kwargs):\n        subprocess.Popen([sys.executable, '-c', ${JSON.stringify(delayedWrite)}], start_new_session=True)\n        return Turn()\n` +
    `class AsyncCodex:\n    async def __aenter__(self): return self\n    async def __aexit__(self, *args): pass\n    async def thread_start(self, **kwargs): return Thread()\n`;
  try {
    await fs.writeFile(path.join(directory, 'openai_codex.py'), stub);
    const helper = path.join(__dirname, '..', 'py', 'codex_bridge.py');
    const child = spawn('python3', ['-u', helper], {
      env: { ...process.env, PYTHONPATH: directory, PYTHONUTF8: '1' }, detached: true
    });
    let output = '';
    const turn = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('"kind": "turn"')) resolve();
      });
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`Helper exited before turn: ${code}\n${output}`)));
    });
    child.stdin.write(JSON.stringify({ requestId: 'eof-test', op: 'send', text: 'wait', mode: 'workspace_write', cwd: directory }) + '\n');
    await turn;
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
    });
    assert.notEqual(exit.code, 0, output);
    await new Promise(resolve => setTimeout(resolve, 750));
    await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Windows EOF waits for taskkill tree completion before exiting the helper', () => {
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
events = []
class Exit(Exception): pass
def run(args, **kwargs):
    events.append('taskkill-start')
    assert args == ['taskkill', '/PID', str(bridge.os.getpid()), '/T', '/F']
    events.append('taskkill-finished')
def finish(code):
    events.append('helper-exit')
    assert code == 1
    raise Exit()
try: bridge.abort_on_parent_eof(platform='nt', run_command=run, exit_process=finish)
except Exit: pass
assert events == ['taskkill-start', 'taskkill-finished', 'helper-exit'], events
events.clear()
def failed_run(args, **kwargs):
    events.append('taskkill-failed')
    raise OSError('taskkill unavailable')
try: bridge.abort_on_parent_eof(platform='nt', run_command=failed_run, exit_process=finish)
except Exit: pass
assert events == ['taskkill-failed', 'helper-exit'], events
print('windows-eof-order=taskkill-finished-before-exit')
`;
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const helper = path.join(__dirname, '..', 'py', 'codex_bridge.py');
  const result = spawnSync(python, ['-c', script, helper], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'windows-eof-order=taskkill-finished-before-exit');
});
