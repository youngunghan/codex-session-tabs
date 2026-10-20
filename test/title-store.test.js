'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TitleStore, MAX_ENTRIES } = require('../src/title-store');
const { fixture, SOURCE, ACCOUNT } = require('./title-fixtures');

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
  await assert.rejects(a.release(), /ownership|token/); await b.release();
});

test('dead writer with pending configuration journal is never reclaimed', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'store');
  const a = new TitleStore(root, { pid: 60001 }); await a.init(); await a.acquire();
  const state = await a.state(true); state.journal = { token: randomUUID(), generation: 0, intended: {} }; await a.save(state);
  const b = new TitleStore(root, { pid: 60002, alive: () => false }); await b.init();
  await assert.rejects(b.acquire(), /pending-write/); await assert.rejects(a.release(), /pending-write/);
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
