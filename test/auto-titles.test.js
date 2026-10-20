'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, A, B, ACCOUNT, deferred, until } = require('./title-fixtures');
const { literalTitle, mayMatch, PATTERNS } = require('../src/auto-titles');
const { createProcessBoundary } = require('../src/title-process-boundary');
const key = id => `**/local/${id}`;

async function assertRetiredOwnerCannotRelease(retired, replacement) {
  await replacement.assertOwner();
  const ownerFile = path.join(replacement.lock, replacement.ownerName);
  const before = await fs.readFile(ownerFile, 'utf8');
  await assert.rejects(retired.release(), error => error instanceof Error && (
    error.message === 'title-writer-ownership-lost' || error.message === 'title-writer-token-mismatch' ||
    (error.code === 'ENOENT' && error.syscall === 'lstat' && error.path === path.join(retired.lock, retired.ownerName))
  ));
  await replacement.assertOwner();
  assert.deepEqual(await fs.readdir(replacement.lock), [replacement.ownerName]);
  assert.equal(await fs.readFile(ownerFile, 'utf8'), before);
}

async function pendingWriter(f) {
  const life = new Map([[60001, true], [60002, true]]);
  const alive = pid => life.has(pid) ? life.get(pid) : true;
  const a = f.make('old-writer', { ids: [A, B], storeOptions: { pid: 60001, alive } });
  await a.manager.enable();
  const state = await a.store.state(true);
  const intended = Object.fromEntries(Object.entries(state.entries).map(([key, row]) => [key, { ...row, value: 'Intended new title' }]));
  const boundary = { pid: 50001, ticks: '638000000000000000', executable: 'c:\\synthetic\\cursor.exe' };
  state.journal = { token: require('node:crypto').randomUUID(), generation: state.generation, intended, boundary };
  await a.store.save(state);
  f.shared.edit(PATTERNS, { [key(A)]: 'Intended new title', [key(B)]: 'User preserved title', '**/src/**': 'User source' });
  clearInterval(a.manager.timer); a.manager.disposed = true; life.set(60001, false);
  const snapshot = previous => ({ complete: true, current: { pid: 60002, parent: 50002, ticks: '638000000000000002', executable: boundary.executable }, parent: { pid: 50002, parent: 1, ticks: '638000000000000001', executable: boundary.executable, mainRole: true }, previous });
  return { a, alive, life, boundary, token: state.journal.token, snapshot };
}

test('default-off start performs no setup, metadata, coordination or settings writes', async t => {
  const f = await fixture(t); const a = f.make('a');
  await a.manager.restoration;
  assert.equal(a.manager.status.kind, 'off');
  assert.equal(a.calls.length, 0); assert.equal(f.shared.writes.length, 0);
  await assert.rejects(fs.stat(a.store.root), { code: 'ENOENT' });
});

test('abandoned claim with no writer distinctly blocks and gives exact full-stop manual remediation', async t => {
  const f = await fixture(t); const a = f.make('blocked'); await a.manager.restoration; await a.store.init();
  const path = require('node:path'), claim = path.join(a.store.root, 'reclaim.claim');
  await fs.writeFile(claim, 'abandoned-foreign-claim');
  const writes = f.shared.writes.length; await a.manager.enable(); await a.manager.heartbeat();
  assert.equal(a.manager.status.kind, 'blocked'); assert.ok(a.manager.status.reason.includes(claim));
  assert.match(a.manager.status.reason, /save all work and fully quit every window and background process/);
  assert.match(a.manager.status.reason, /remove ONLY/); assert.match(a.manager.status.reason, /Preserve writer.lock, state.json, requests and salt/);
  assert.match(a.manager.status.reason, /Never remove the claim while any previous IDE process/);
  assert.equal(a.calls.length, 0); assert.equal(f.shared.writes.length, writes);
  await assert.rejects(fs.stat(a.store.lock), { code: 'ENOENT' });
  await a.manager.dispose(); assert.equal(await fs.readFile(claim, 'utf8'), 'abandoned-foreign-claim');
  // Emulate the documented full-stop operator step ONLY in our owned fixture.
  const root = await fs.lstat(a.store.root), file = await fs.lstat(claim);
  assert.equal(root.dev, a.store.identity.dev); assert.equal(root.ino, a.store.identity.ino); assert.equal(root.isSymbolicLink(), false);
  assert.equal(path.dirname(claim), a.store.root); assert.ok(!path.relative(f.root, claim).startsWith('..'));
  assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink === 1);
  await fs.unlink(claim);
  const b = f.make('after-full-stop'); await b.manager.enable();
  assert.equal(b.manager.status.kind, 'ready'); assert.equal(b.calls.length, 1);
});

for (const eligibility of ['new-official-version', 'new-codex-home', 'unknown-build', 'native', 'missing-runtime']) for (const override of [false, true]) test(`restart privacy cleanup ignores ${eligibility} eligibility with ${override ? 'folder override' : 'removed exclusion'}`, async t => {
  const f = await fixture(t); const a = f.make('old', { ids: [A, B] }); await a.manager.enable();
  await a.manager.dispose();
  f.shared.edit(PATTERNS, { ...f.shared.values[PATTERNS], [key(B)]: 'User preserved title', '**/src/**': 'User source' });
  if (override) f.shared.overrides[PATTERNS] = { workspaceFolderValue: { '**/local/*': 'Scoped user label' } };
  else f.shared.edit('settingsSync.ignoredSettings', []);
  const support = eligibility === 'unknown-build' || eligibility === 'native' ? async () => ({ mode: eligibility === 'native' ? 'native' : 'blocked', reason: 'Synthetic unsupported build' }) : eligibility === 'missing-runtime' ? undefined : async () => ({ mode: 'cursor', source: eligibility === 'new-official-version' ? 'c'.repeat(64) : 'd'.repeat(64), binary: '/synthetic/new-cli', codexHome: '/synthetic/new-home' });
  const b = f.make('restart', { support, missingRuntime: eligibility === 'missing-runtime' });
  let installCalls = 0; b.manager.runtime.install = () => { installCalls++; throw new Error('must not install during cleanup'); };
  const writes = f.shared.writes.length;
  await b.manager.refresh(); await b.manager.heartbeat();
  assert.equal(b.calls.length, 0); assert.equal(installCalls, 0);
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(f.shared.values[PATTERNS][key(B)], 'User preserved title');
  assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  assert.equal(f.shared.writes.slice(writes).some(row => row.key === PATTERNS && row.value[key(A)]), false);
  assert.equal((await b.store.state(true)).enabled, false); assert.equal(b.manager.status.kind, 'blocked');
  if (override) assert.deepEqual(f.shared.overrides[PATTERNS].workspaceFolderValue, { '**/local/*': 'Scoped user label' });
  else assert.deepEqual(f.shared.values['settingsSync.ignoredSettings'], []);
});

test('off restart probes existing ownership read-only then cleans a missing exclusion without enabling metadata', async t => {
  const f = await fixture(t); const a = f.make('old', { ids: [A, B] }); await a.manager.enable(); await a.manager.dispose();
  f.shared.edit(PATTERNS, { ...f.shared.values[PATTERNS], [key(B)]: 'User preserved title', '**/src/**': 'User source' });
  f.shared.edit('codexSessionTabs.autoTitles.enabled', false); f.shared.edit('settingsSync.ignoredSettings', []);
  const b = f.make('off-restart', { support: async () => ({ mode: 'blocked', reason: 'Unknown synthetic build' }) });
  await b.manager.restoration;
  assert.equal(b.calls.length, 0); assert.equal(b.manager.preference(), false);
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(f.shared.values[PATTERNS][key(B)], 'User preserved title');
  assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  assert.equal(b.manager.status.kind, 'blocked');
});

test('healthy context change retires old owned labels only without another live old-context request', async t => {
  const f = await fixture(t); const a = f.make('old', { ids: [A, B] }); await a.manager.enable(); await a.manager.dispose();
  f.shared.edit(PATTERNS, { ...f.shared.values[PATTERNS], [key(B)]: 'User preserved title', '**/src/**': 'User source' });
  const b = f.make('new-context', { support: async () => ({ mode: 'cursor', source: 'd'.repeat(64), binary: '/new/cli', codexHome: '/new/home' }) });
  await b.manager.refresh();
  assert.equal(b.calls.length, 0); assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(f.shared.values[PATTERNS][key(B)], 'User preserved title'); assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  assert.equal((await b.store.state(true)).enabled, false); assert.equal(b.manager.status.kind, 'blocked');
  assert.ok(f.shared.values['settingsSync.ignoredSettings'].includes(PATTERNS));
});

test('healthy live old context is preserved even with an aged request; privacy removal still cleans globally', async t => {
  const f = await fixture(t); const a = f.make('old'); await a.manager.enable();
  clearInterval(a.manager.timer); clearTimeout(a.manager.debounce);
  const requestPath = require('node:path').join('requests', `${a.store.instance}.json`);
  const request = JSON.parse(await a.store.readText(requestPath)); request.updatedAt -= 60000; await a.store.atomic(requestPath, request);
  await a.store.release();
  const b = f.make('different-context', { support: async () => ({ mode: 'cursor', source: 'd'.repeat(64), binary: '/new/cli', codexHome: '/new/home' }) });
  await b.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha'); assert.equal(b.calls.length, 0); assert.equal(b.store.owned, null);
  f.shared.edit('settingsSync.ignoredSettings', []); await b.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined); assert.equal(b.calls.length, 0); assert.equal(b.manager.status.kind, 'blocked');
});

test('remote restart never acquires local ownership or changes persisted labels for privacy cleanup', async t => {
  const f = await fixture(t); const a = f.make('old'); await a.manager.enable(); await a.manager.dispose();
  f.shared.edit('settingsSync.ignoredSettings', []); const writes = f.shared.writes.length;
  const b = f.make('remote', { remoteName: 'ssh-remote' }); await b.manager.refresh();
  assert.equal(b.manager.initialized, undefined); assert.equal(b.calls.length, 0); assert.equal(f.shared.writes.length, writes);
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha'); assert.equal(b.manager.status.kind, 'blocked');
});

test('enable excludes whole patterns before data, preserves unrelated settings and disable retains exclusion', async t => {
  const f = await fixture(t); f.shared.edit(PATTERNS, { '**/src/**': 'User source' }); f.shared.edit('settingsSync.ignoredSettings', ['user.setting']);
  const a = f.make('a', { ids: [A, B] }); await a.manager.enable();
  assert.equal(a.manager.status.kind, 'ready');
  const privacy = f.shared.writes.findIndex(row => row.key === 'settingsSync.ignoredSettings');
  const title = f.shared.writes.findIndex(row => row.key === PATTERNS);
  assert.ok(privacy >= 0 && privacy < title);
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha'); assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  await a.manager.disable();
  assert.deepEqual(f.shared.values[PATTERNS], { '**/src/**': 'User source' });
  assert.deepEqual(f.shared.values['settingsSync.ignoredSettings'], ['user.setting', PATTERNS]);
  assert.equal(f.shared.values['codexSessionTabs.autoTitles.enabled'], false);
});

test('manual exclusion removal rejects stale metadata, removes exact owned values and blocks re-addition', async t => {
  const f = await fixture(t); const wait = deferred(); const entered = deferred(); let delayed = false;
  const a = f.make('a', { metadata: async request => { if (delayed) { entered.resolve(); return wait.promise; } return { identity: ACCOUNT, threads: request.ids.map(id => ({ id, title: 'Fake title' })) }; } });
  await a.manager.enable(); delayed = true;
  const pending = a.manager.refresh(); await entered.promise;
  f.shared.edit('settingsSync.ignoredSettings', []);
  wait.resolve({ identity: ACCOUNT, threads: [{ id: A, title: 'Stale unsafe reply' }] });
  await pending; await a.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(a.manager.status.kind, 'blocked');
  const count = f.shared.writes.length; await a.manager.refresh();
  assert.equal(f.shared.writes.length, count);
  assert.deepEqual(f.shared.values['settingsSync.ignoredSettings'], []);
});

for (const [setting, scope] of [['settingsSync.ignoredSettings', 'workspaceValue'], [PATTERNS, 'workspaceFolderValue']]) test(`${scope} override of ${setting} after Enable rejects pending titles and cleans exact ownership`, async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); let calls = 0;
  const C = '0199ab00-0000-7000-8000-000000000003';
  const a = f.make('writer', { ids: [A, B], metadata: async request => {
    calls++;
    if (calls > 1) { entered.resolve(); await release.promise; }
    return { identity: ACCOUNT, threads: request.ids.map(id => ({ id, title: calls > 1 ? 'Stale forbidden title' : 'Initial owned title' })) };
  } });
  await a.manager.enable();
  a.tabs.push({ input: new a.api.TabInputCustom({ scheme: 'openai-codex', authority: 'route', path: `/local/${C}` }, 'chatgpt.conversationEditor') });
  const pending = a.manager.refresh(); await entered.promise;
  f.shared.edit(PATTERNS, { ...f.shared.values[PATTERNS], [key(B)]: 'User preserved title', '**/src/**': 'User source' });
  const scopedValue = setting === PATTERNS ? { '**/local/*': 'Scoped user label' } : [];
  f.shared.overrides[setting] = { [scope]: scopedValue }; f.shared.fire(setting);
  const writeCount = f.shared.writes.length;
  release.resolve(); await pending;
  await a.manager.heartbeat(); await a.manager.refresh();
  assert.equal(calls, 2, 'scope conflict cannot launch a retry or later metadata');
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(f.shared.values[PATTERNS][key(B)], 'User preserved title');
  assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  assert.equal(f.shared.values[PATTERNS][key(C)], undefined);
  assert.equal(f.shared.writes.slice(writeCount).some(row => row.key === PATTERNS && Object.values(row.value).includes('Stale forbidden title')), false);
  assert.deepEqual(f.shared.overrides[setting][scope], scopedValue);
  assert.equal(a.manager.status.kind, 'blocked'); assert.equal((await a.store.state(true)).enabled, false);
});

test('unrelated user pattern edit invalidates old reply and automatically retries once with accurate status', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); let calls = 0;
  const a = f.make('writer', { metadata: async request => {
    const attempt = ++calls;
    if (attempt === 1) { entered.resolve(); await release.promise; }
    return { identity: ACCOUNT, threads: request.ids.map(id => ({ id, title: attempt === 1 ? 'Stale forbidden title' : 'Fresh retried title' })) };
  } });
  const enabling = a.manager.enable(); await entered.promise;
  f.shared.edit(PATTERNS, { '**/src/**': 'User source' });
  release.resolve(); await enabling;
  assert.equal(a.manager.status.kind, 'pending');
  await until(() => calls === 2 && a.manager.status.kind === 'ready');
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fresh retried title');
  assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  assert.equal(f.shared.writes.some(row => row.key === PATTERNS && Object.values(row.value).includes('Stale forbidden title')), false);
  await a.manager.heartbeat(); await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(calls, 2, 'completed event retry cannot become an idle heartbeat retry loop');
  assert.equal(a.manager.status.kind, 'ready');
});

test('exclusion is rechecked after durable journal await and before any new title write', async t => {
  const f = await fixture(t); const a = f.make('a');
  const save = a.store.save.bind(a.store); let revoked = false;
  a.store.save = async state => { await save(state); if (state.journal && !revoked) { revoked = true; f.shared.edit('settingsSync.ignoredSettings', []); } };
  await a.manager.enable(); await a.manager.refresh();
  assert.equal(f.shared.writes.some(row => row.key === PATTERNS && row.value[key(A)]), false);
  assert.equal(a.manager.status.kind, 'blocked');
});

for (const cleanup of [false, true]) test(`external edit during journal await survives ${cleanup ? 'cleanup' : 'metadata'} write`, async t => {
  const f = await fixture(t); const a = f.make('writer');
  if (cleanup) await a.manager.enable();
  const entered = deferred(), release = deferred(); const save = a.store.save.bind(a.store); let delayed = false;
  a.store.save = async state => {
    await save(state);
    if (state.journal && !delayed) { delayed = true; entered.resolve(); await release.promise; }
  };
  const pending = cleanup ? a.manager.disable() : a.manager.enable();
  await entered.promise;
  f.shared.edit(PATTERNS, { ...f.shared.values[PATTERNS], [key(A)]: 'User changed while journal awaited', '**/src/**': 'User addition' });
  const writes = f.shared.writes.length;
  release.resolve(); await pending;
  assert.equal(f.shared.values[PATTERNS][key(A)], 'User changed while journal awaited');
  assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User addition');
  assert.equal(f.shared.writes.slice(writes).some(row => row.key === PATTERNS), false);
  assert.equal((await a.store.state(true)).journal, null);
  assert.equal((await a.store.state(true)).enabled, false);
});

test('user edits and overlapping user patterns are preserved without enforcing an old owned label', async t => {
  const f = await fixture(t); const a = f.make('a'); await a.manager.enable();
  f.shared.edit(PATTERNS, { ...f.shared.values[PATTERNS], [key(A)]: 'User selected title' });
  await a.manager.refresh(); await a.manager.disable();
  assert.equal(f.shared.values[PATTERNS][key(A)], 'User selected title');
  await a.manager.enable();
  assert.equal(f.shared.values[PATTERNS][key(A)], 'User selected title');
});

test('new broad user glob relinquishes exact unchanged owned entry', async t => {
  const f = await fixture(t); const a = f.make('a'); await a.manager.enable();
  f.shared.edit(PATTERNS, { ...f.shared.values[PATTERNS], '**/local/*': 'User glob' });
  const calls = a.calls.length; await a.manager.heartbeat();
  assert.equal(f.shared.values[PATTERNS]['**/local/*'], 'User glob');
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(a.calls.length, calls, 'settings reconciliation does not request new metadata');
});

for (const conflict of ['negative', 'scope', 'disabled', 'unregistered']) test(`fails closed before exclusion/data for ${conflict} setting conflict`, async t => {
  const f = await fixture(t);
  if (conflict === 'negative') f.shared.edit('settingsSync.ignoredSettings', [`-${PATTERNS}`]);
  if (conflict === 'scope') f.shared.overrides[PATTERNS] = { workspaceValue: {} };
  if (conflict === 'disabled') f.shared.edit('workbench.editor.customLabels.enabled', false);
  if (conflict === 'unregistered') f.shared.overrides['settingsSync.ignoredSettings'] = { unregistered: true };
  const a = f.make('a'); await a.manager.enable(); await a.manager.refresh();
  assert.equal(a.manager.status.kind, 'blocked'); assert.equal(f.shared.writes.length, 0);
});

test('settled cleanup rejection clears journal, retains exact ownership and allows a later disable retry', async t => {
  const f = await fixture(t); const a = f.make('a'); await a.manager.enable();
  f.shared.hook = async full => { if (full === PATTERNS) throw new Error('private@example.invalid token-sensitive'); };
  f.shared.edit('settingsSync.ignoredSettings', []); await a.manager.refresh();
  assert.equal(a.manager.status.kind, 'blocked'); assert.ok(a.warnings.length);
  assert.equal((await a.store.state(true)).journal, null);
  assert.equal((await a.store.state(true)).enabled, false);
  assert.ok((await a.store.state(true)).entries[key(A)]);
  const writes = f.shared.writes.length; await a.manager.refresh(); assert.equal(f.shared.writes.length, writes);
  assert.equal(JSON.stringify(a.manager.status).includes('private@'), false);
  f.shared.hook = null; await a.manager.disable();
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(a.manager.status.kind, 'off');
});

test('unknown identity clears owned context and never exposes raw helper failures', async t => {
  const f = await fixture(t); let fail = false;
  const a = f.make('a', { metadata: async request => { if (fail) { const error = new Error('email=private@example.invalid token=secret title=PRIVATE'); error.code = 'METADATA_IDENTITY_UNAVAILABLE'; throw error; } return { identity: ACCOUNT, threads: request.ids.map(id => ({ id, title: 'Fake title' })) }; } });
  await a.manager.enable(); fail = true; await a.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined); assert.equal(a.manager.status.kind, 'blocked');
  assert.equal(JSON.stringify([a.manager.status, a.warnings]).includes('private@example'), false);
});

for (const outcome of ['no-write', 'applied', 'user-edited']) test(`settled ${outcome} rejection reconciles prior/intended exact values before later cleanup`, async t => {
  const f = await fixture(t); const a = f.make('writer', { ids: [A, B] }); await a.manager.enable();
  const state = await a.store.state(true); const base = { ...f.shared.values[PATTERNS] };
  const patterns = { ...base, [key(A)]: 'New intended Alpha', [key(B)]: 'New intended Beta' };
  const entries = Object.fromEntries(Object.entries(state.entries).map(([key, row]) => [key, { ...row, value: patterns[key] }]));
  f.shared.hook = async (full, value) => {
    if (full !== PATTERNS) return;
    if (outcome !== 'no-write') f.shared.edit(PATTERNS, outcome === 'user-edited' ? { ...value, [key(A)]: 'User changed title' } : value);
    throw new Error('private@example.invalid token-sensitive');
  };
  await assert.rejects(a.manager.writePatterns(state, patterns, entries, true, base, a.manager.epoch), { code: 'TITLE_WRITE_REJECTED' });
  const reconciled = await a.store.state(true);
  assert.equal(reconciled.journal, null);
  assert.equal(reconciled.entries[key(A)]?.value, outcome === 'user-edited' ? undefined : outcome === 'applied' ? 'New intended Alpha' : 'Fake Alpha');
  assert.equal(reconciled.entries[key(B)].value, outcome === 'no-write' ? 'Fake Beta' : 'New intended Beta');
  f.shared.hook = null;
  if (outcome === 'applied') { f.shared.edit('settingsSync.ignoredSettings', []); await a.manager.heartbeat(); }
  else await a.manager.disable();
  assert.equal(f.shared.values[PATTERNS][key(A)], outcome === 'user-edited' ? 'User changed title' : undefined);
  assert.equal(f.shared.values[PATTERNS][key(B)], undefined);
});

test('explicit Disable recovers dead journal only after verified old main exit, consent and fresh recheck', async t => {
  const f = await fixture(t); const old = await pendingWriter(f); let checks = 0, dialogs = 0;
  const boundary = createProcessBoundary({ pid: 60002, executable: old.boundary.executable, snapshot: async () => { checks++; return old.snapshot(null); } });
  const b = f.make('new-writer', { boundary, storeOptions: { pid: 60002, alive: old.alive } });
  b.api.window.showWarningMessage = async (message, options, button) => { if (options?.modal) { dialogs++; assert.match(message, /Save your work/); assert.match(message, /Cancel leaves settings and your previous title request unchanged/); return button; } };
  await b.manager.disable();
  assert.equal(dialogs, 1); assert.ok(checks >= 3, 'two exit checks and own new cleanup boundary');
  const state = await b.store.state(true);
  assert.equal(state.journal, null); assert.equal(state.enabled, false); assert.deepEqual(state.entries, {});
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(f.shared.values[PATTERNS][key(B)], 'User preserved title');
  assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  assert.ok(f.shared.values['settingsSync.ignoredSettings'].includes(PATTERNS));
  assert.equal(b.manager.preference(), false); assert.equal(b.manager.status.kind, 'off');
  await assertRetiredOwnerCannotRelease(old.a.store, b.store);
});

for (const failure of ['automatic', 'cancel', 'old-main-alive', 'same-main', 'ambiguous', 'changed-during-dialog', 'writer-alive', 'writer-unknown']) test(`dead-journal recovery refuses ${failure} without changing user settings`, async t => {
  const f = await fixture(t); const old = await pendingWriter(f); let checks = 0, dialogs = 0;
  if (failure === 'writer-alive') old.life.set(60001, true);
  if (failure === 'writer-unknown') old.life.set(60001, null);
  const boundary = createProcessBoundary({ pid: 60002, executable: old.boundary.executable, snapshot: async () => {
    checks++;
    if (failure === 'ambiguous') throw new Error('private process query unavailable');
    const value = old.snapshot(failure === 'old-main-alive' || (failure === 'changed-during-dialog' && checks > 1) ? old.boundary : null);
    if (failure === 'same-main') { value.current.parent = 50001; value.parent = { ...value.parent, pid: 50001 }; }
    return value;
  } });
  const b = f.make('new-writer', { boundary, storeOptions: { pid: 60002, alive: old.alive } });
  b.api.window.showWarningMessage = async (_message, options, button) => { if (options?.modal) { dialogs++; return failure === 'cancel' ? undefined : button; } };
  const before = JSON.stringify(f.shared.values); const writes = f.shared.writes.length;
  if (failure === 'automatic') { await b.manager.refresh(); await b.manager.heartbeat(); }
  else await b.manager.disable();
  assert.equal(JSON.stringify(f.shared.values), before); assert.equal(f.shared.writes.length, writes);
  assert.equal((await b.store.state(true)).journal.token, old.token); assert.equal(b.store.owned, null);
  assert.equal(dialogs, ['cancel', 'changed-during-dialog'].includes(failure) ? 1 : 0);
  if (failure === 'cancel') await assert.rejects(b.store.readText(require('node:path').join('requests', `${b.store.instance}.json`)), { code: 'ENOENT' });
});

test('canceled recovery restores the prior request and cannot queue a later disable for an eligible writer', async t => {
  const f = await fixture(t); const old = await pendingWriter(f);
  const boundary = createProcessBoundary({ pid: 60002, executable: old.boundary.executable, snapshot: async () => old.snapshot(null) });
  const b = f.make('canceling-window', { boundary, storeOptions: { pid: 60002, alive: old.alive } });
  await b.manager.enable(); // Preserve a real prior Enable request/control.
  const requestFile = require('node:path').join('requests', `${b.store.instance}.json`);
  const prior = JSON.parse(await b.store.readText(requestFile));
  b.api.window.showWarningMessage = async () => undefined;
  await b.manager.disable();
  assert.deepEqual(JSON.parse(await b.store.readText(requestFile)), prior);
  assert.deepEqual(b.manager.control, prior.control);
  const state = await old.a.store.state(true); state.journal.settled = true; await old.a.store.save(state);
  old.life.set(60003, true);
  const c = f.make('eligible-writer', { storeOptions: { pid: 60003, alive: old.alive } });
  await c.manager.refresh(); await c.manager.heartbeat();
  assert.equal((await c.store.state(true)).enabled, true); assert.equal(c.manager.preference(), true);
  assert.equal((await c.store.requests()).some(row => row.instance === b.store.instance && row.control?.kind === 'disable'), false);
});

test('idle heartbeat past 30 seconds and zero-tab refresh never launch a helper', async t => {
  const f = await fixture(t); const a = f.make('writer'); await a.manager.enable();
  const calls = a.calls.length; const now = Date.now;
  Date.now = () => now() + 60000;
  try { await a.manager.heartbeat(); await a.manager.heartbeat(); } finally { Date.now = now; }
  assert.equal(a.calls.length, calls);
  a.tabs.length = 0; await a.manager.heartbeat(); await a.manager.refresh();
  assert.equal(a.calls.length, calls);
  assert.equal((await a.store.state(true)).enabled, true);
  await a.manager.disable(); await a.manager.dispose();
  const b = f.make('empty', { ids: [] }); await b.manager.enable(); await b.manager.refresh();
  assert.equal(b.calls.length, 0); assert.equal((await b.store.state(true)).enabled, true);
});

test('new compatible follower IDs trigger metadata on coordination but unchanged IDs do not', async t => {
  const f = await fixture(t); const a = f.make('writer'); await a.manager.enable();
  const b = f.make('follower', { ids: [B] }); await b.manager.enable();
  await a.manager.heartbeat();
  assert.equal(a.calls.length, 2); assert.deepEqual(new Set(a.calls[1]), new Set([A, B]));
  await a.manager.heartbeat(); assert.equal(a.calls.length, 2); assert.equal(b.calls.length, 0);
});

for (const timeout of [false, true]) test(`transient ${timeout ? 'timeout' : 'transport error'} retains enabled cache/privacy until explicit refresh retries`, async t => {
  const f = await fixture(t); const a = f.make('writer', { timeout: 15 }); await a.manager.enable();
  const good = a.manager.metadata; let failures = 0;
  a.manager.metadata = () => { failures++; return timeout ? new Promise(() => {}) : Promise.reject(new Error('private@example.invalid token-sensitive')); };
  await a.manager.refresh();
  assert.equal((await a.store.state(true)).enabled, true); assert.equal(a.manager.preference(), true);
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha'); assert.equal(a.manager.configuration(true).ok, true);
  assert.equal(a.manager.status.kind, 'blocked'); assert.equal(JSON.stringify(a.manager.status).includes('private@'), false);
  await a.manager.heartbeat(); assert.equal(failures, 1);
  a.manager.metadata = good; await a.manager.refresh();
  assert.equal(a.manager.status.kind, 'ready'); assert.equal((await a.store.state(true)).blocked, '');
});

test('account change removes old unchanged cached context before applying new identity', async t => {
  const f = await fixture(t); let account = ACCOUNT;
  const a = f.make('a', { ids: [A, B], metadata: async request => ({ identity: account, threads: request.ids.map(id => ({ id, title: account === ACCOUNT ? 'Old fake context' : 'New fake context' })) }) });
  await a.manager.enable(); a.tabs.pop(); account = 'c'.repeat(64); await a.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], 'New fake context'); assert.equal(f.shared.values[PATTERNS][key(B)], undefined);
  assert.equal((await a.store.state(true)).entries[key(A)].account, account);
});

test('missing metadata leaves unknown IDs native, and helper timeout stops without settings writes', async t => {
  const f = await fixture(t); const a = f.make('a', { metadata: async () => ({ identity: ACCOUNT, threads: [] }) });
  await a.manager.enable(); assert.equal(f.shared.writes.some(row => row.key === PATTERNS), false);
  await a.manager.disable();
  const b = f.make('b', { metadata: () => new Promise(() => {}), timeout: 15 });
  await a.manager.dispose(); await b.manager.enable();
  assert.equal(b.manager.status.kind, 'blocked');
});

test('native provider and remote/unknown support return without SDK/Sync/pattern mutation', async t => {
  const f = await fixture(t);
  for (const mode of ['native', 'blocked']) {
    const a = f.make(mode, { support: async () => ({ mode, reason: 'Synthetic support boundary' }) });
    await a.manager.enable(); assert.equal(a.calls.length, 0); assert.equal(f.shared.writes.length, 0);
  }
});

test('literal sanitization rejects interpolation/control-only values and bounds Unicode safely', () => {
  assert.equal(literalTitle('${filename}'), undefined); assert.equal(literalTitle('\n\0'), undefined);
  assert.equal(literalTitle('one\n two\0three'), 'one two three');
  const title = literalTitle('😀'.repeat(100)); assert.ok(title.length <= 120); assert.equal(title.endsWith('\ud83d'), false);
  assert.equal(mayMatch('**/src/**', A), false); assert.equal(mayMatch('**/local/*', A), true);
});

test('long astral metadata survives durable cache round trips', async t => {
  const f = await fixture(t); const a = f.make('a', { metadata: async () => ({ identity: ACCOUNT, threads: [{ id: A, title: '😀'.repeat(100) }] }) });
  await a.manager.enable(); await a.manager.refresh();
  assert.equal((await a.store.state(true)).entries[key(A)].value.length, 120);
  assert.equal(a.manager.status.kind, 'ready');
});

test('two managers use one writer, union tabs, retain cached absent mappings and block incompatible follower', async t => {
  const f = await fixture(t); const a = f.make('writer'); await a.manager.enable();
  const b = f.make('follower', { ids: [B] }); await b.manager.enable(); await a.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha'); assert.equal(f.shared.values[PATTERNS][key(B)], 'Fake Beta');
  assert.deepEqual([...new Set(f.shared.writes.map(row => row.actor))], ['writer']); assert.equal(b.calls.length, 0);
  a.tabs.length = 0; await a.manager.refresh(); assert.ok((await a.store.state(true)).entries[key(A)]);
  const c = f.make('incompatible', { support: async () => ({ mode: 'cursor', source: 'c'.repeat(64), binary: '/other/cli', codexHome: '/other/home' }) });
  await c.manager.enable(); assert.equal(c.manager.status.kind, 'blocked'); assert.match(c.manager.status.reason, /different Codex/);
  await b.manager.disable(); await a.manager.refresh(); await a.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined); assert.equal(f.shared.values[PATTERNS][key(B)], undefined);
  assert.equal((await a.store.state(true)).enabled, false);
});

test('manual off while an owned pattern write is awaiting completion is processed and cleaned', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred();
  f.shared.hook = async full => { if (full === PATTERNS && !entered.done) { entered.done = true; entered.resolve(); await release.promise; } };
  const a = f.make('writer'); const enabling = a.manager.enable(); await entered.promise;
  f.shared.edit('codexSessionTabs.autoTitles.enabled', false);
  await until(() => Boolean(a.manager.control?.kind === 'disable'));
  release.resolve(); await enabling; await a.manager.refresh();
  assert.equal((await a.store.state(true)).enabled, false); assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
});

test('follower disable invalidates a writer metadata reply before any label update', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); let delayed = false;
  const a = f.make('writer', { metadata: async request => {
    if (delayed) { entered.resolve(); await release.promise; }
    return { identity: ACCOUNT, threads: request.ids.map(id => ({ id, title: delayed ? 'Stale reply after disable' : 'Initial title' })) };
  } });
  await a.manager.enable();
  const b = f.make('follower', { ids: [B] }); await b.manager.enable();
  delayed = true; const pending = a.manager.refresh(); await entered.promise;
  await b.manager.disable(); release.resolve(); await pending;
  assert.equal((await a.store.state(true)).enabled, false);
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(f.shared.writes.some(row => row.key === PATTERNS && Object.values(row.value).includes('Stale reply after disable')), false);
});

test('full cache skips a new mapping and retains cached mappings absent from requests', async t => {
  const f = await fixture(t); const a = f.make('writer'); await a.manager.enable();
  const state = await a.store.state(true); const patterns = { ...f.shared.values[PATTERNS] };
  for (let i = 2; i <= 250; i++) {
    const id = `0199ab00-0000-7000-8000-${String(i).padStart(12, '0')}`;
    patterns[key(id)] = 'Cached fake title'; state.entries[key(id)] = { value: 'Cached fake title', source: a.manager.source, account: ACCOUNT };
  }
  await a.store.save(state); f.shared.edit(PATTERNS, patterns);
  const newId = '0199ab00-0000-7000-8000-999999999999';
  a.tabs[0].input.uri.path = `/local/${newId}`;
  await a.manager.refresh();
  assert.equal(Object.keys((await a.store.state(true)).entries).length, 250);
  assert.equal(f.shared.values[PATTERNS][key(newId)], undefined);
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha');
  assert.equal(a.manager.status.kind, 'limited');
});

test('disposal waits for publications before unpublish, preventing a stale enable resurrection', async t => {
  const f = await fixture(t); const a = f.make('writer'); await a.manager.enable();
  const entered = deferred(), release = deferred(); const publish = a.store.publish.bind(a.store);
  a.store.publish = async request => { entered.resolve(); await release.promise; await publish(request); };
  const pending = a.manager.publish(); await entered.promise;
  const disposing = a.manager.dispose(); let finished = false; disposing.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  release.resolve(); await pending; await disposing;
  await assert.rejects(fs.stat(require('node:path').join(a.store.root, 'requests', `${a.store.instance}.json`)), { code: 'ENOENT' });
});

test('writer disposal never releases lock while its configuration promise is in flight', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); let waiting = false;
  f.shared.hook = async full => { if (full === PATTERNS && !waiting) { waiting = true; entered.resolve(); await release.promise; } };
  const a = f.make('writer'); const enabling = a.manager.enable(); await entered.promise;
  const disposing = a.manager.dispose();
  assert.notEqual((await a.store.state(true)).journal.settled, true, 'an unresolved API promise is never marked settled');
  const b = f.make('follower', { ids: [B] }); await b.manager.enable();
  assert.equal(b.store.owned, null); assert.equal(f.shared.writes.some(row => row.actor === 'follower'), false);
  release.resolve(); await enabling; await disposing; await b.manager.refresh();
  assert.equal(b.manager.status.kind, 'ready'); assert.ok(b.store.owned);
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha'); assert.equal(f.shared.values[PATTERNS][key(B)], 'Fake Beta');
});
