'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TitleStore, MAX_ENTRIES } = require('../src/title-store');
const { fixture, SOURCE, ACCOUNT, A, B, deferred } = require('./title-fixtures');

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

test('racing atomic acquisitions produce at most one writer and followers cannot save', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store');
  const a = new TitleStore(root), b = new TitleStore(root); await a.init(); await b.init();
  assert.equal(a.salt, b.salt);
  const results = await Promise.allSettled([a.acquire(), b.acquire()]);
  assert.equal(results.filter(row => row.status === 'fulfilled' && row.value === true).length, 1);
  const writer = a.owned ? a : b, follower = a.owned ? b : a;
  await assert.rejects(follower.save(await writer.state(true)), /ownership/);
  await writer.release(); assert.equal(await follower.acquire(), true); await follower.release();
});

test('positively dead writer without journal can be replaced; old token cannot release replacement', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store'); let alive = true;
  const a = new TitleStore(root, { pid: 60001, alive: () => alive }); await a.init(); await a.acquire();
  const b = new TitleStore(root, { pid: 60002, alive: () => false }); await b.init(); alive = false;
  assert.equal(await b.acquire(), true);
  await assertRetiredOwnerCannotRelease(a, b); await b.release();
});

test('concurrent dead-writer reclaim holds one claim from old snapshot through replacement', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store');
  const alive = pid => pid !== 60001;
  const dead = new TitleStore(root, { pid: 60001, alive }), slow = new TitleStore(root, { pid: 60002, alive }), other = new TitleStore(root, { pid: 60003, alive });
  for (const store of [dead, slow, other]) await store.init();
  await dead.acquire();
  const entered = deferred(), resume = deferred(); const state = slow.state.bind(slow); let paused = false;
  slow.state = async required => { const value = await state(required); if (!paused) { paused = true; entered.resolve(); await resume.promise; } return value; };
  const taking = slow.acquire(); await entered.promise;
  await assert.rejects(other.acquire(), { code: 'TITLE_ACQUISITION_CLAIM_BLOCKED' });
  assert.deepEqual(await fs.readdir(slow.lock), [dead.ownerName]);
  resume.resolve(); assert.equal(await taking, true);
  await assert.rejects(fs.stat(path.join(root, 'reclaim.claim')), { code: 'ENOENT' });
  assert.equal(await other.acquire(), false);
  const value = await slow.state(true); value.generation++; await slow.save(value);
  await assertRetiredOwnerCannotRelease(dead, slow);
  await slow.release(); assert.equal(await other.acquire(), true); await other.release();
});

test('release after its directory listing succeeds while another acquisition holds a sibling claim', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store');
  const a = new TitleStore(root), b = new TitleStore(root), c = new TitleStore(root);
  for (const store of [a, b, c]) await store.init(); await a.acquire();
  const listed = deferred(), finishRelease = deferred(); const state = a.state.bind(a);
  a.state = async required => { const value = await state(required); listed.resolve(); await finishRelease.promise; return value; };
  const releasing = a.release(); await listed.promise;
  const claimed = deferred(), finishClaim = deferred(); const withClaim = b.withReclaimClaim.bind(b);
  b.withReclaimClaim = action => withClaim(async () => { claimed.resolve(); await finishClaim.promise; return action(); });
  const taking = b.acquire(); await claimed.promise;
  assert.deepEqual(await fs.readdir(a.lock), [a.ownerName]);
  finishRelease.resolve(); await releasing;
  await assert.rejects(fs.stat(a.lock), { code: 'ENOENT' });
  await assert.rejects(c.acquire(), { code: 'TITLE_ACQUISITION_CLAIM_BLOCKED' });
  finishClaim.resolve(); assert.equal(await taking, true);
  await b.release(); assert.equal(await c.acquire(), true); await c.release();
});

for (const change of ['directory', 'owner', 'liveness', 'journal']) test(`reclaim ${change} change removes only its own claim and preserves current ownership`, async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store'); let live = false;
  const dead = new TitleStore(root, { pid: 60001 }), b = new TitleStore(root, { pid: 60002, alive: () => live });
  await dead.init(); await b.init(); await dead.acquire();
  const read = b.state.bind(b); let changed = false, expectedOwner = dead.ownerName;
  b.state = async required => {
    const value = await read(required);
    if (!changed) {
      changed = true;
      if (change === 'directory') {
        await fs.rename(b.lock, `${b.lock}-retired`); await fs.mkdir(b.lock);
        const token = randomUUID(); expectedOwner = `owner-${token}.json`;
        await fs.writeFile(path.join(b.lock, expectedOwner), JSON.stringify({ token, pid: 60003 }));
      } else if (change === 'owner') await fs.writeFile(path.join(b.lock, dead.ownerName), JSON.stringify({ token: dead.token, pid: 60003 }));
      else if (change === 'liveness') live = true;
      else await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ ...value, journal: { token: randomUUID(), generation: value.generation, intended: {} } }));
    }
    return value;
  };
  await assert.rejects(b.acquire(), /reclaim/);
  await assert.rejects(fs.stat(path.join(root, 'reclaim.claim')), { code: 'ENOENT' });
  assert.equal(b.owned, null); assert.deepEqual(await fs.readdir(b.lock), [expectedOwner]);
  if (change === 'owner' || change === 'directory') assert.equal(JSON.parse(await fs.readFile(path.join(b.lock, expectedOwner))).pid, 60003);
  if (change === 'journal') assert.ok((await b.state(true)).journal);
});

for (const length of [0, 7]) test(`partial claim write of ${length} bytes cleans its captured file identity`, async t => {
  const f = await fixture(t); const store = new TitleStore(path.join(f.root, 'store')); await store.init();
  const claim = path.join(store.root, 'reclaim.claim'), open = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === claim) { const write = handle.writeFile.bind(handle); handle.writeFile = async token => { if (length) await write(token.slice(0, length)); throw new Error('injected-token-write-failure'); }; }
    return handle;
  };
  try { await assert.rejects(store.withReclaimClaim(() => assert.fail('action must not run')), /injected-token-write-failure/); }
  finally { fs.open = open; }
  await assert.rejects(fs.stat(claim), { code: 'ENOENT' });
});

test('preexisting foreign claim distinctly blocks fresh acquisition and is never removed', async t => {
  const f = await fixture(t); const store = new TitleStore(path.join(f.root, 'store')); await store.init();
  const claim = path.join(store.root, 'reclaim.claim'); await fs.writeFile(claim, 'foreign-claim');
  await assert.rejects(store.acquire(), { code: 'TITLE_ACQUISITION_CLAIM_BLOCKED' });
  assert.equal(await fs.readFile(claim, 'utf8'), 'foreign-claim');
  await assert.rejects(fs.stat(store.lock), { code: 'ENOENT' });
});

for (const replacement of ['file', 'contents', 'junction', 'hardlink']) test(`claim cleanup preserves a foreign ${replacement} substitution`, async t => {
  const f = await fixture(t); const store = new TitleStore(path.join(f.root, 'store')); await store.init();
  const claim = path.join(store.root, 'reclaim.claim'), foreign = path.join(f.root, 'foreign-file');
  await fs.writeFile(foreign, 'foreign-content');
  const target = path.join(f.root, 'foreign-directory'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'marker'), 'foreign-content');
  await assert.rejects(store.withReclaimClaim(async () => {
    if (replacement === 'contents') await fs.writeFile(claim, 'foreign-content');
    else {
      await fs.rename(claim, `${claim}.retired`);
      if (replacement === 'file') await fs.writeFile(claim, 'foreign-content');
      else if (replacement === 'hardlink') await fs.link(foreign, claim);
      else await fs.symlink(target, claim, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }), /claim/);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign-content');
  if (replacement === 'junction') { assert.equal((await fs.lstat(claim)).isSymbolicLink(), true); assert.equal(await fs.readFile(path.join(target, 'marker'), 'utf8'), 'foreign-content'); }
  else assert.equal(await fs.readFile(claim, 'utf8'), 'foreign-content');
});

test('unresolved-journal recovery keeps one claim across the empty-directory gap and then cleans exact owned labels', async t => {
  const f = await fixture(t); const life = new Map([[60001, true], [60002, true], [60003, true]]), alive = pid => life.get(pid) ?? true;
  const old = f.make('old', { ids: [A, B], storeOptions: { pid: 60001, alive } }); await old.manager.enable();
  const state = await old.store.state(true), token = randomUUID();
  const intended = Object.fromEntries(Object.entries(state.entries).map(([key, row]) => [key, { ...row, value: 'Intended owned title' }]));
  state.journal = { token, generation: state.generation, intended, boundary: { pid: 50001, ticks: '638000000000000000', executable: 'c:\\synthetic\\cursor.exe' } };
  await old.store.save(state); clearInterval(old.manager.timer); clearTimeout(old.manager.debounce); old.manager.disposed = true; life.set(60001, false);
  const { PATTERNS } = require('../src/auto-titles'); const key = id => `**/local/${id}`;
  f.shared.edit(PATTERNS, { [key(A)]: 'Intended owned title', [key(B)]: 'User preserved title', '**/src/**': 'User source' });
  const b = f.make('reclaimer', { storeOptions: { pid: 60002, alive }, boundary: { capture: async () => ({ pid: 50002, ticks: '638000000000000001', executable: 'c:\\synthetic\\cursor.exe' }), exited: async () => true } });
  b.api.window.showWarningMessage = async (_message, options, button) => options?.modal ? button : undefined;
  const gap = deferred(), resume = deferred(); const acquire = b.store.acquireClaimed.bind(b.store); let attempts = 0;
  b.store.acquireClaimed = async options => { if (++attempts === 2) { gap.resolve(); await resume.promise; } return acquire(options); };
  const reconcile = b.manager.reconcileJournal.bind(b.manager); let authorityMatched = false;
  b.manager.reconcileJournal = async value => { if (value.journal?.token === token) authorityMatched = b.store.recoveredJournal === token; return reconcile(value); };
  const disabling = b.manager.disable(); await gap.promise;
  await assert.rejects(fs.stat(b.store.lock), { code: 'ENOENT' });
  const c = f.make('contender', { storeOptions: { pid: 60003, alive } }); const writes = f.shared.writes.length;
  await c.manager.refresh(); assert.equal(c.store.owned, null); assert.equal(c.calls.length, 0); assert.equal(f.shared.writes.length, writes);
  assert.equal(c.manager.status.kind, 'blocked'); assert.match(c.manager.status.reason, /reclaim\.claim/);
  await assert.rejects(fs.stat(b.store.lock), { code: 'ENOENT' });
  resume.resolve(); await disabling;
  assert.equal(authorityMatched, true); assert.equal((await b.store.state(true)).journal, null);
  assert.equal((await b.store.state(true)).enabled, false); assert.equal(f.shared.values[PATTERNS][key(A)], undefined);
  assert.equal(f.shared.values[PATTERNS][key(B)], 'User preserved title'); assert.equal(f.shared.values[PATTERNS]['**/src/**'], 'User source');
  await c.manager.dispose(); await b.manager.dispose();
  const next = new TitleStore(b.store.root, { pid: 60004, alive }); await next.init(); assert.equal(await next.acquire(), true); await next.release();
});

test('dead writer with pending configuration journal is never reclaimed', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store');
  const a = new TitleStore(root, { pid: 60001 }); await a.init(); await a.acquire();
  const state = await a.state(true); state.journal = { token: randomUUID(), generation: 0, intended: {} }; await a.save(state);
  const b = new TitleStore(root, { pid: 60002, alive: () => false }); await b.init();
  await assert.rejects(b.acquire(), /pending-write/); await assert.rejects(a.release(), /pending-write/);
});

test('a durably settled journal permits dead-writer takeover but stays journaled until exact reconciliation', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store');
  const a = new TitleStore(root, { pid: 60001 }); await a.init(); await a.acquire();
  const state = await a.state(true); state.journal = { token: randomUUID(), generation: 0, intended: {}, settled: true }; await a.save(state);
  const b = new TitleStore(root, { pid: 60002, alive: () => false }); await b.init();
  assert.equal(await b.acquire(), true); assert.equal((await b.state(true)).journal.settled, true);
  await assertRetiredOwnerCannotRelease(a, b);
  await assert.rejects(b.release(), /pending-write/);
  const reconciled = await b.state(true); reconciled.journal = null; await b.save(reconciled); await b.release();
});

test('age alone never steals missing-bootstrap or ambiguous-liveness locks', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store'); const a = new TitleStore(root); await a.init();
  await fs.mkdir(a.lock); await fs.utimes(a.lock, 1, 1);
  await assert.rejects(a.acquire(), /bootstrap/);
  await fs.rmdir(a.lock); await a.acquire();
  const b = new TitleStore(root, { alive: () => null }); await b.init();
  await assert.rejects(b.acquire(), /liveness-ambiguous/); await a.release();
});

test('near-capacity CJK ownership and doubled pending journal remain bounded and readable', async t => {
  const f = await fixture(t); const a = new TitleStore(path.join(f.root, 'store')); await a.init(); await a.acquire();
  const state = await a.state(true);
  for (let i = 0; i < MAX_ENTRIES; i++) state.entries[`**/local/${randomUUID()}`] = { value: '한'.repeat(120), source: SOURCE, account: ACCOUNT };
  state.journal = { token: randomUUID(), generation: state.generation, intended: { ...state.entries } }; await a.save(state);
  assert.ok((await fs.stat(path.join(a.root, 'state.json'))).size > 256 * 1024);
  assert.equal(Object.keys((await a.state(true)).entries).length, MAX_ENTRIES);
});

test('corrupt ownership and replaced lock directory fail closed', async t => {
  const f = await fixture(t); const a = new TitleStore(path.join(f.root, 'store')); await a.init(); await a.acquire();
  await fs.rename(a.lock, `${a.lock}-old`); await fs.mkdir(a.lock);
  await assert.rejects(a.assertOwner(), /ownership-lost/);
  await fs.writeFile(path.join(a.root, 'state.json'), '{"version":999}');
  await assert.rejects(a.state(true), /state-invalid/);
});
