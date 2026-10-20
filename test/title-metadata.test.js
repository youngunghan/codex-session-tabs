'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { SdkRuntime } = require('../src/runtime');
const { validateMessage } = require('../src/protocol');
const { A, B } = require('./title-fixtures');

test('metadata bridge uses only public account/list, bounded pages and requested canonical IDs', () => {
  const script = `
import asyncio, importlib.util, json, os, sys, types
stub=types.ModuleType('openai_codex')
stub.ApprovalMode=stub.Sandbox=object
stub.__version__='0.162.1'
stub.CodexConfig=lambda **kwargs: kwargs
calls=[]
binary=os.path.abspath('synthetic-cli'); home=os.path.abspath('synthetic-home')
class Codex:
    def __init__(self, config): assert config['codex_bin']==binary
    async def __aenter__(self): return self
    async def __aexit__(self,*args): pass
    async def account(self,refresh_token=False):
        assert refresh_token is False
        calls.append('account')
        return types.SimpleNamespace(account=types.SimpleNamespace(root=types.SimpleNamespace(type='chatgpt',email='Private@Example.invalid')))
    async def thread_list(self,limit,cursor):
        assert limit==50
        calls.append('list')
        return types.SimpleNamespace(data=[types.SimpleNamespace(id='${A}',name='Fake Alpha',preview='ignored body'),types.SimpleNamespace(id='${B}',name='Not requested',preview='ignored')],next_cursor='bounded-next')
    def __getattr__(self,key): raise AssertionError('Forbidden SDK method '+key)
stub.AsyncCodex=Codex
sys.modules['openai_codex']=stub
spec=importlib.util.spec_from_file_location('bridge',sys.argv[1]); bridge=importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
events=[]; bridge.emit=lambda kind,**fields: events.append(dict(kind=kind,**fields))
request={'op':'metadata','ids':['${A}'],'salt':'ab'*32,'codexBin':binary,'codexHome':home}
asyncio.run(bridge.run(request))
assert calls==['account','list','account'],calls
assert len(events)==1 and events[0]['kind']=='metadata'
assert events[0]['threads']==[{'id':'${A}','title':'Fake Alpha'}]
assert len(events[0]['identity'])==64
assert 'private@example.invalid' not in json.dumps(events).lower()
request['ids']=['0199ab00-0000-7000-8000-000000000099']; calls.clear(); events.clear()
asyncio.run(bridge.run(request))
assert calls==['account','list','list','list','account'],calls
assert events[0]['threads']==[] and events[0]['discoveryComplete'] is False
print('bounded=true public_metadata_only=true account_plaintext=false')
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', script, path.join(__dirname, '..', 'py', 'codex_bridge.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /public_metadata_only=true/);
});

test('metadata init/account/list/validation failures emit fixed classifications without secret exception text', () => {
  const script = `
import asyncio, importlib.util, io, json, os, sys, threading, types
stub=types.ModuleType('openai_codex'); stub.ApprovalMode=stub.Sandbox=object; stub.__version__='0.162.1'; stub.CodexConfig=lambda **kwargs:kwargs
failure=''
seen=[]; binary=os.path.abspath('synthetic-cli'); home=os.path.abspath('synthetic-home')
secret='private@example.invalid TOKEN-SECRET PRIVATE-TITLE'
class Codex:
    def __init__(self,*args): seen.append('init')
    async def __aenter__(self):
        if failure=='init': raise RuntimeError(secret)
        return self
    async def __aexit__(self,*args): pass
    async def account(self,refresh_token=False):
        seen.append('account')
        if failure=='account': raise ValueError(secret)
        account=types.SimpleNamespace(type='apikey',email=secret) if failure=='identity' else types.SimpleNamespace(type='chatgpt',email='test@example.invalid')
        return types.SimpleNamespace(account=types.SimpleNamespace(root=account))
    async def thread_list(self,**kwargs):
        seen.append('list'); raise RuntimeError(secret)
stub.AsyncCodex=Codex; sys.modules['openai_codex']=stub
spec=importlib.util.spec_from_file_location('bridge',sys.argv[1]); bridge=importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
class Watcher:
    def __init__(self): self.operation_done=threading.Event()
bridge.InputWatcher=Watcher
for stage in ['init','account','identity','list','validation']:
    failure=stage; events=[]; seen=[]
    request={'requestId':'redacted-test','op':'metadata','ids':['${A}'],'salt':'ab'*32,'codexBin':binary,'codexHome':home}
    if stage=='validation': request['ids']=[secret]
    sys.stdin=io.StringIO(json.dumps(request)+chr(10))
    bridge.emit=lambda kind,**fields:events.append(dict(kind=kind,**fields))
    try: asyncio.run(bridge.main()); raise AssertionError('expected failure')
    except SystemExit as error: assert error.code==1
    assert len(events)==1 and events[0]['code']==('METADATA_IDENTITY_UNAVAILABLE' if stage=='identity' else 'METADATA_UNAVAILABLE'),events
    assert seen=={'init':['init'],'account':['init','account'],'identity':['init','account'],'list':['init','account','list'],'validation':[]}[stage],(stage,seen)
    assert secret not in json.dumps(events) and 'private@example' not in json.dumps(events)
print('redacted_failure_stages=5')
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', script, path.join(__dirname, '..', 'py', 'codex_bridge.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /stages=5/);
});

function runtime(events, stderr = '') {
  return new SdkRuntime({ globalStorageUri: { fsPath: '/synthetic' }, extensionPath: '/synthetic' }, {}, () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.write = line => { const request = JSON.parse(line); queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      for (const event of events) child.stdout.emit('data', Buffer.from(JSON.stringify({ requestId: request.requestId, ...event }) + '\n'));
      child.emit('close', stderr ? 1 : 0);
    }); };
    child.kill = () => {};
    return child;
  }, () => {});
}

test('metadata terminal framing is distinct and runtime error events/stderr remain redacted', async () => {
  const seen = []; const good = runtime([{ kind: 'metadata', identity: 'a'.repeat(64), threads: [] }]);
  await good.run({ op: 'metadata' }, event => seen.push(event)).promise;
  assert.equal(seen.length, 1);
  good.ready = true; await assert.rejects(good.run({ op: 'send' }, () => {}).promise, /Unexpected/);
  const secret = 'private@example.invalid TOKEN-SECRET PRIVATE-TITLE';
  const errors = []; await assert.rejects(runtime([{ kind: 'error', message: secret }]).run({ op: 'metadata' }, event => errors.push(event)).promise, error => !error.message.includes(secret));
  assert.equal(JSON.stringify(errors).includes(secret), false);
  await assert.rejects(runtime([], secret).run({ op: 'metadata' }, () => {}).promise, error => !error.message.includes(secret));
  await assert.rejects(runtime([{ kind: 'error', code: 'METADATA_IDENTITY_UNAVAILABLE', message: secret }]).run({ op: 'metadata' }, () => {}).promise, { code: 'METADATA_IDENTITY_UNAVAILABLE' });
  await assert.rejects(runtime([{ kind: 'completed' }]).run({ op: 'metadata' }, () => {}).promise, /metadata unavailable/);
  assert.equal(validateMessage({ type: 'metadata', salt: 'anything' }), undefined, 'webviews cannot invoke internal metadata request');
});
