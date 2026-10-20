'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture, A, B, ACCOUNT, deferred, until } = require('./title-fixtures');
const { literalTitle, mayMatch, PATTERNS } = require('../src/auto-titles');
const key = id => `**/local/${id}`;

test('default-off start performs no setup, metadata, coordination or settings writes', async t => {
  const f = await fixture(t); const a = f.make('a');
  assert.equal(a.manager.status.kind, 'off');
  assert.equal(a.calls.length, 0); assert.equal(f.shared.writes.length, 0);
  await assert.rejects(fs.stat(a.store.root), { code: 'ENOENT' });
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
  await a.manager.refresh();
  assert.equal(f.shared.values[PATTERNS]['**/local/*'], 'User glob');
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
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

test('cleanup failure retains journal, warns persistently and blocks later title writes', async t => {
  const f = await fixture(t); const a = f.make('a'); await a.manager.enable();
  f.shared.hook = async full => { if (full === PATTERNS) throw new Error('private@example.invalid token-sensitive'); };
  f.shared.edit('settingsSync.ignoredSettings', []); await a.manager.refresh();
  assert.equal(a.manager.status.kind, 'blocked'); assert.ok(a.warnings.length);
  assert.ok((await a.store.state(true)).journal);
  const writes = f.shared.writes.length; await a.manager.refresh(); assert.equal(f.shared.writes.length, writes);
  assert.equal(JSON.stringify(a.manager.status).includes('private@'), false);
});

test('unknown identity clears owned context and never exposes raw helper failures', async t => {
  const f = await fixture(t); let fail = false;
  const a = f.make('a', { metadata: async request => { if (fail) throw new Error('email=private@example.invalid token=secret title=PRIVATE'); return { identity: ACCOUNT, threads: request.ids.map(id => ({ id, title: 'Fake title' })) }; } });
  await a.manager.enable(); fail = true; await a.manager.refresh();
  assert.equal(f.shared.values[PATTERNS][key(A)], undefined); assert.equal(a.manager.status.kind, 'blocked');
  assert.equal(JSON.stringify([a.manager.status, a.warnings]).includes('private@example'), false);
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
  const b = f.make('follower', { ids: [B] }); await b.manager.enable();
  assert.equal(b.store.owned, null); assert.equal(f.shared.writes.some(row => row.actor === 'follower'), false);
  release.resolve(); await enabling; await disposing; await b.manager.refresh();
  assert.equal(b.manager.status.kind, 'ready'); assert.ok(b.store.owned);
  assert.equal(f.shared.values[PATTERNS][key(A)], 'Fake Alpha'); assert.equal(f.shared.values[PATTERNS][key(B)], 'Fake Beta');
});
