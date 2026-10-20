'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^\*\*\/local\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 250;
const freshState = () => ({ version: 1, enabled: false, generation: 0, source: null, account: null, entries: {}, controls: {}, blocked: '', journal: null });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

class TitleStore {
  constructor(directory, options = {}) {
    this.root = path.resolve(directory);
    this.pid = options.pid || process.pid;
    this.alive = options.alive || processAlive;
    this.instance = options.instance || randomUUID();
    if (!ID.test(this.instance) || !Number.isInteger(this.pid) || this.pid <= 0) throw new Error('title-instance-invalid');
    this.token = randomUUID();
    this.lock = path.join(this.root, 'writer.lock');
    this.ownerName = `owner-${this.token}.json`;
    this.owned = null;
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('title-store-root-invalid');
    this.identity ||= stat;
    if (!same(this.identity, stat)) throw new Error('title-store-root-replaced');
    const requests = path.join(this.root, 'requests');
    await fs.mkdir(requests, { recursive: true });
    const requestStat = await fs.lstat(requests);
    if (!requestStat.isDirectory() || requestStat.isSymbolicLink()) throw new Error('title-requests-invalid');
    let salt;
    try { salt = (await this.readText('salt')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await fs.writeFile(path.join(this.root, 'salt'), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
      catch (created) { if (created.code !== 'EEXIST') throw created; }
      salt = (await this.readText('salt')).trim();
    }
    if (!HASH.test(salt)) throw new Error('title-profile-salt-invalid');
    this.salt = salt;
  }

  async readText(relative) {
    const file = path.join(this.root, relative);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('title-store-file-invalid');
    return fs.readFile(file, 'utf8');
  }

  async atomic(relative, value) {
    const stat = await fs.lstat(this.root);
    if (!same(this.identity, stat) || stat.isSymbolicLink()) throw new Error('title-store-root-replaced');
    const target = path.join(this.root, relative);
    const parent = await fs.lstat(path.dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('title-store-parent-invalid');
    const temporary = path.join(path.dirname(target), `.tmp-${this.instance}-${randomUUID()}`);
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    const identity = await fs.lstat(temporary);
    try { await fs.rename(temporary, target); }
    catch (error) {
      try { const latest = await fs.lstat(temporary); if (!latest.isSymbolicLink() && same(identity, latest)) await fs.unlink(temporary); } catch { /* Keep the original storage failure. */ }
      throw error;
    }
  }

  async state(required = false) {
    let state;
    try { state = JSON.parse(await this.readText('state.json')); }
    catch (error) { if (!required && error.code === 'ENOENT') return freshState(); throw new Error('title-ownership-state-invalid'); }
    if (state.version !== 1 || typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.generation) || state.generation < 0 || !state.entries || Array.isArray(state.entries) || Object.keys(state.entries).length > MAX_ENTRIES || !state.controls || Array.isArray(state.controls) || Object.keys(state.controls).length > 128 || Object.entries(state.controls).some(([instance, id]) => !ID.test(instance) || !ID.test(id)) || typeof state.blocked !== 'string') throw new Error('title-ownership-state-invalid');
    if ((state.source !== null && !HASH.test(state.source)) || (state.account !== null && !HASH.test(state.account))) throw new Error('title-ownership-context-invalid');
    for (const [key, row] of Object.entries(state.entries)) {
      if (!KEY.test(key) || !row || typeof row.value !== 'string' || row.value.length > 160 || !HASH.test(row.source) || !HASH.test(row.account)) throw new Error('title-ownership-entry-invalid');
    }
    if (state.journal !== null && (!state.journal || !ID.test(state.journal.token) || !Number.isSafeInteger(state.journal.generation))) throw new Error('title-write-journal-invalid');
    return state;
  }

  async assertOwner() {
    const stat = await fs.lstat(this.lock);
    if (!this.owned || stat.isSymbolicLink() || !same(stat, this.owned)) throw new Error('title-writer-ownership-lost');
    const owner = JSON.parse(await this.readText(path.join('writer.lock', this.ownerName)));
    if (owner.token !== this.token || owner.pid !== this.pid) throw new Error('title-writer-token-mismatch');
  }

  async save(state) { await this.assertOwner(); await this.atomic('state.json', state); }

  async acquire() {
    if (this.owned) { await this.assertOwner(); return true; }
    try { await fs.mkdir(this.lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(this.lock);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('title-writer-lock-invalid');
      const files = await fs.readdir(this.lock);
      if (files.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/i.test(files[0])) throw new Error('title-writer-bootstrap-ambiguous');
      const owner = JSON.parse(await this.readText(path.join('writer.lock', files[0])));
      if (!ID.test(owner.token) || files[0] !== `owner-${owner.token}.json` || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('title-writer-owner-invalid');
      const alive = this.alive(owner.pid);
      if (alive === true) return false;
      if (alive !== false) throw new Error('title-writer-liveness-ambiguous');
      if ((await this.state(true)).journal) throw new Error('title-dead-writer-pending-write; manual review required');
      // A unique claim inside the old directory serializes cooperative reclaim.
      // A crashed reclaimer leaves an ambiguous lock, which is never age-stolen.
      const claim = path.join(this.lock, 'reclaim.claim');
      try { await fs.writeFile(claim, this.token, { flag: 'wx', mode: 0o600 }); }
      catch (claimed) { if (claimed.code === 'EEXIST') return false; throw claimed; }
      const latest = await fs.lstat(this.lock);
      if (!same(stat, latest) || latest.isSymbolicLink()) throw new Error('title-lock-replaced-during-reclaim');
      if (this.alive(owner.pid) !== false || (await this.state(true)).journal) throw new Error('title-reclaim-no-longer-safe');
      await fs.unlink(path.join(this.lock, files[0]));
      await fs.unlink(claim);
      await fs.rmdir(this.lock);
      return this.acquire();
    }
    this.owned = await fs.lstat(this.lock);
    await fs.writeFile(path.join(this.lock, this.ownerName), JSON.stringify({ token: this.token, pid: this.pid }), { flag: 'wx', mode: 0o600 });
    await this.save(await this.state());
    return true;
  }

  async release() {
    if (!this.owned) return;
    await this.assertOwner();
    const files = await fs.readdir(this.lock);
    if (files.length !== 1 || files[0] !== this.ownerName) throw new Error('title-lock-release-ambiguous');
    if ((await this.state(true)).journal) throw new Error('title-pending-write-lock-retained');
    await fs.unlink(path.join(this.lock, this.ownerName));
    await fs.rmdir(this.lock);
    this.owned = null;
  }

  async publish(request) {
    await this.atomic(path.join('requests', `${this.instance}.json`), { version: 1, instance: this.instance, pid: this.pid, updatedAt: Date.now(), ...request });
  }

  async requests() {
    const rows = [];
    this.requestInstances = new Set();
    const names = await fs.readdir(path.join(this.root, 'requests'));
    if (names.length > 128) throw new Error('title-request-capacity-exceeded');
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) { if (name.startsWith('.tmp-')) continue; throw new Error('title-request-name-invalid'); }
      const row = JSON.parse(await this.readText(path.join('requests', name)));
      if (row.version !== 1 || !ID.test(row.instance) || name !== `${row.instance}.json` || !Number.isInteger(row.pid) || row.pid <= 0 || !HASH.test(row.source) || !HASH.test(row.workspace) || !Array.isArray(row.ids) || row.ids.length > 100 || row.ids.some(id => !ID.test(id)) || !Number.isFinite(row.updatedAt) || (row.control && (!ID.test(row.control.id) || !['enable', 'disable'].includes(row.control.kind)))) throw new Error('title-request-invalid');
      const live = this.alive(row.pid);
      if (live === false && this.owned) {
        await this.assertOwner();
        await fs.unlink(path.join(this.root, 'requests', name));
        continue;
      }
      this.requestInstances.add(row.instance);
      if (live === null) throw new Error('title-request-liveness-ambiguous');
      const recent = Date.now() - row.updatedAt >= -1000 && Date.now() - row.updatedAt < 10000;
      if (live === true && recent) rows.push(row);
      // Request absence/expiry never prunes cached pattern ownership.
    }
    return rows;
  }

  async unpublish() {
    try {
      const row = JSON.parse(await this.readText(path.join('requests', `${this.instance}.json`)));
      if (row.instance === this.instance && row.pid === this.pid) await fs.unlink(path.join(this.root, 'requests', `${this.instance}.json`));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { TitleStore, freshState, processAlive, MAX_ENTRIES, ID, HASH, KEY };
