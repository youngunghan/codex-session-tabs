'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TitleStore, MAX_ENTRIES, ID, HASH } = require('./title-store');
const { createSupport, hash } = require('./title-support');
const { createProcessBoundary } = require('./title-process-boundary');

const PREF = 'autoTitles.enabled';
const PATTERNS = 'workbench.editor.customLabels.patterns';
const COMMANDS = { enable: 'codexSessionTabs.enableAutoTitles', disable: 'codexSessionTabs.disableAutoTitles', refresh: 'codexSessionTabs.refreshAutoTitles' };
const clone = value => JSON.parse(JSON.stringify(value));
const handled = (state, row) => state.controls[row.instance] === row.control?.id;

function literalTitle(value) {
  if (typeof value !== 'string' || value.includes('${')) return undefined;
  let title = '';
  for (const char of value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()) {
    if (title.length + char.length > 120) break;
    title += char;
  }
  return title || undefined;
}

function mayMatch(pattern, id) {
  // Conservative for advanced glob syntax: never override a possibly matching
  // user-owned pattern when we cannot prove the simple glob is unrelated.
  if (/[{}[\]()!]/.test(pattern)) return true;
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') { expression += '(?:.*/)?'; index++; }
      else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[\\^$+.]/g, '\\$&');
  }
  try { const regex = new RegExp(`^${expression}$`); return [id, `local/${id}`, `/local/${id}`, `openai-codex://route/local/${id}`].some(value => regex.test(value)); }
  catch { return true; }
}

class AutoTitles {
  constructor(context, api, runtime, options = {}) {
    this.context = context;
    this.api = api;
    this.runtime = runtime;
    this.options = options;
    this.support = options.support || createSupport(api, context);
    this.store = options.store || new TitleStore(path.join(context.globalStorageUri.fsPath, 'auto-titles-v1'));
    this.boundary = options.boundary || createProcessBoundary();
    this.metadata = options.metadata || (request => {
      let reply;
      const operation = runtime.run({ op: 'metadata', ...request }, event => { if (event.kind === 'metadata') reply = event; });
      this.operation = operation;
      return operation.promise.then(() => reply).finally(() => { if (this.operation === operation) this.operation = null; });
    });
    this.epoch = 0;
    this.active = false;
    this.disposed = false;
    this.ownWrites = 0;
    this.status = { kind: 'off', reason: 'Automatic tab titles are off.' };
    this.statusItem = api.window.createStatusBarItem?.();
    if (this.statusItem) this.statusItem.command = COMMANDS.refresh;
    this.setStatus('off', this.status.reason);
  }

  start() {
    const subscriptions = this.context.subscriptions;
    subscriptions.push(this.api.window.tabGroups.onDidChangeTabs(() => { if (this.active) this.schedule(); }));
    if (this.api.workspace.onDidChangeConfiguration) subscriptions.push(this.api.workspace.onDidChangeConfiguration(event => {
      if (this.disposed) return;
      const pref = event.affectsConfiguration('codexSessionTabs.autoTitles.enabled');
      const privacy = event.affectsConfiguration('settingsSync.ignoredSettings');
      const patterns = event.affectsConfiguration(PATTERNS);
      const enabled = event.affectsConfiguration('workbench.editor.customLabels.enabled');
      if (!pref && !privacy && !patterns && !enabled) return;
      const ownPref = pref && this.expectedMutation?.full === 'codexSessionTabs.autoTitles.enabled' && this.preference() === this.expectedMutation.value;
      if (this.ownWrites && !privacy && (!pref || ownPref)) return; // Readback checks our pattern writes; manual off is never suppressed.
      if (this.ownWrites && privacy && (!pref || ownPref) && !enabled && this.expectedMutation?.full === 'settingsSync.ignoredSettings' && this.configuration(true).ok) return;
      this.invalidate();
      if (pref && !this.preference() && this.control?.kind !== 'disable') void this.disable(false).catch(() => this.block('Automatic title disable could not complete; refresh or inspect local ownership storage.'));
      else if (this.active || this.preference()) { this.active = true; this.schedule(); }
    }));
    if (this.api.workspace.onDidChangeWorkspaceFolders) subscriptions.push(this.api.workspace.onDidChangeWorkspaceFolders(() => { this.invalidate(); if (this.active) this.schedule(); }));
    if (this.preference()) { this.active = true; this.schedule(true); }
    return this;
  }

  preference() { return this.api.workspace.getConfiguration('codexSessionTabs').get(PREF, false) === true; }
  setStatus(kind, reason) {
    this.status = { kind, reason };
    if (this.statusItem) {
      this.statusItem.text = `Codex titles: ${{ ready: 'Active', following: 'Active', pending: 'Updating', limited: 'Some unavailable', blocked: 'Needs attention', native: 'Native', off: 'Off' }[kind] || kind}`;
      this.statusItem.tooltip = reason;
      if (kind === 'off') this.statusItem.hide?.(); else this.statusItem.show();
    }
  }
  block(reason, warn = false) {
    this.setStatus('blocked', reason);
    if (warn && this.lastWarning !== reason) { this.lastWarning = reason; void this.api.window.showWarningMessage?.(reason); }
  }
  invalidate() { this.epoch++; this.operation?.abort?.(); }
  invalidatedFetch(epoch) {
    if (this.disposed) return true;
    if (this.epoch === epoch) return false;
    const privacy = this.configuration(true);
    if (this.preference() && privacy.ok) {
      this.lastSignature = undefined;
      this.setStatus('pending', 'Label settings changed during discovery. Automatic titles will retry after those changes settle.');
      this.schedule(); // One debounced event retry, not a heartbeat poll.
    } else {
      this.block(privacy.reason || 'Automatic titles were disabled during discovery.');
      this.queued = true; // Cleanup only; privacy checks precede any fetch.
    }
    return true;
  }

  ids() {
    const result = new Set();
    for (const group of this.api.window.tabGroups.all) for (const tab of group.tabs) {
      if (!(tab.input instanceof this.api.TabInputCustom) || tab.input.viewType !== 'chatgpt.conversationEditor') continue;
      const uri = tab.input.uri;
      const match = uri.scheme === 'openai-codex' && uri.authority === 'route' && /^\/local\/([0-9a-f-]{36})\/?$/i.exec(uri.path);
      if (match && ID.test(match[1])) result.add(match[1].toLowerCase());
    }
    return [...result].slice(0, 100);
  }

  configuration(requireExclusion) {
    const scopes = [undefined, ...(this.api.workspace.workspaceFolders || []).map(folder => folder.uri)];
    const inspect = (section, key) => this.api.workspace.getConfiguration(section).inspect(key);
    const ignored = inspect('settingsSync', 'ignoredSettings');
    const patterns = inspect('workbench.editor.customLabels', 'patterns');
    const enabled = inspect('workbench.editor.customLabels', 'enabled');
    if (!ignored || !patterns || !enabled) return { ok: false, reason: 'Required title/Sync settings are not registered in this IDE.' };
    for (const scope of scopes) for (const [section, key] of [['settingsSync', 'ignoredSettings'], ['workbench.editor.customLabels', 'patterns'], ['workbench.editor.customLabels', 'enabled']]) {
      const row = this.api.workspace.getConfiguration(section, scope).inspect(key);
      if (!row || ['workspaceValue', 'workspaceFolderValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue', 'globalLanguageValue'].some(name => row[name] !== undefined)) return { ok: false, reason: 'A workspace/language override conflicts with automatic title privacy or labels.' };
    }
    const effectiveIgnored = this.api.workspace.getConfiguration('settingsSync').get('ignoredSettings');
    const globalIgnored = ignored.globalValue || [];
    if (!Array.isArray(effectiveIgnored) || !Array.isArray(globalIgnored) || globalIgnored.some(value => typeof value !== 'string') || effectiveIgnored.some(value => typeof value !== 'string')) return { ok: false, reason: 'The Sync exclusion list has an unsupported value.' };
    const negative = `-${PATTERNS}`;
    if (globalIgnored.includes(negative) || effectiveIgnored.includes(negative)) return { ok: false, reason: 'A negative Sync exclusion explicitly includes tab-label patterns in Sync.' };
    if (requireExclusion && (!globalIgnored.includes(PATTERNS) || !effectiveIgnored.includes(PATTERNS))) return { ok: false, reason: 'The tab-label Sync exclusion was removed. Run Enable Automatic Tab Titles explicitly to restore it.' };
    if (this.api.workspace.getConfiguration('workbench.editor.customLabels').get('enabled') !== true) return { ok: false, reason: 'Custom labels are disabled; automatic titles preserve that preference.' };
    const globalPatterns = patterns.globalValue || {};
    if (!globalPatterns || typeof globalPatterns !== 'object' || Array.isArray(globalPatterns)) return { ok: false, reason: 'User tab-label patterns have an unsupported value.' };
    return { ok: true, patterns: clone(globalPatterns), ignored: Array.from(globalIgnored) };
  }

  async configUpdate(section, key, value) {
    this.ownWrites++;
    this.expectedMutation = { full: `${section}.${key}`, value };
    try { await this.api.workspace.getConfiguration(section).update(key, value, this.api.ConfigurationTarget.Global); }
    finally { this.ownWrites--; this.expectedMutation = null; }
  }

  async ensureStore(source) {
    if (!this.initialized) { await this.store.init(); this.initialized = true; }
    if (this.disposed) return;
    this.source = source;
    if (!this.timer) {
      this.timer = setInterval(() => { void this.heartbeat().catch(() => this.block('Local title coordination failed; no new labels will be written.', true)); }, 2000);
      this.timer.unref?.();
    }
  }
  async heartbeat() {
    if (this.disposed || !this.active) return;
    await this.publish();
    await this.enqueue(); // Coordination/privacy/new IDs, never an idle poll.
  }
  publish() {
    if (!this.initialized || !this.source || this.disposed) return Promise.resolve();
    this.publications = (this.publications || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.disposed) return;
      await this.store.publish({ source: this.source, workspace: hash(JSON.stringify((this.api.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort())), ids: this.ids(), control: this.control || null });
    });
    return this.publications;
  }
  restorePublication(previous) {
    this.publications = (this.publications || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.disposed) return; // Disposal unpublishes after this queue drains.
      if (previous === null) await this.store.unpublish();
      else await this.store.atomic(path.join('requests', `${this.store.instance}.json`), previous);
    });
    return this.publications;
  }

  async prepare() {
    const support = await this.support();
    if (support.mode !== 'cursor') { this.setStatus(support.mode === 'native' ? 'native' : 'blocked', support.reason); return null; }
    if (!this.options.metadata) {
      try { await fs.access(this.runtime.python); }
      catch {
        this.block('Codex SDK is not set up. Use Enable Automatic Tab Titles and choose Set up Codex SDK.');
        return null;
      }
    }
    await this.ensureStore(support.source);
    this.sourceContext = support;
    return support;
  }

  async enable() {
    if (this.disposed) return;
    this.active = true;
    let support = await this.prepare();
    if (!support) {
      if (this.status.reason.includes('not set up')) {
        const choice = await this.api.window.showWarningMessage?.('Automatic titles need the Codex Python SDK. Setup is user-invoked and does not replace the official UI.', 'Set up Codex SDK');
        if (choice === 'Set up Codex SDK') {
          await this.api.window.withProgress({ location: this.api.ProgressLocation.Notification, title: 'Setting up Codex SDK for tab titles' }, progress => this.runtime.install(line => progress.report({ message: String(line).trim().slice(-200) })));
          support = await this.prepare();
        }
      }
      if (!support) return;
    }
    this.invalidate();
    this.control = { kind: 'enable', id: randomUUID() };
    await this.publish();
    return this.enqueue(true);
  }

  async disable(explicit = true) {
    if (this.disposed || this.api.env.remoteName) { this.block('Disable automatic titles in the local IDE profile; remote settings ownership is unverified.'); return; }
    const priorActive = this.active, priorControl = this.control;
    this.invalidate();
    this.active = true;
    await this.ensureStore(this.source || hash('cleanup-only'));
    let priorRequest = null;
    if (explicit) {
      try { priorRequest = JSON.parse(await this.store.readText(path.join('requests', `${this.store.instance}.json`))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (priorRequest && (priorRequest.instance !== this.store.instance || priorRequest.pid !== this.store.pid)) throw new Error('title-prior-request-invalid');
    }
    const control = { kind: 'disable', id: randomUUID() };
    this.control = control;
    await this.publish();
    const recovery = explicit ? { attempted: false } : null;
    this.recovery = recovery;
    try { return await this.enqueue(true); }
    finally {
      if (recovery?.refused && this.control?.id === control.id) {
        this.control = priorControl; this.active = priorActive;
        await this.restorePublication(priorRequest);
      }
      if (this.recovery === recovery) this.recovery = null;
    }
  }

  async refresh() {
    if (this.disposed) return;
    if (!this.active && !this.preference()) { this.setStatus('off', 'Automatic tab titles are off.'); return; }
    this.active = true;
    if (!this.initialized && !await this.prepare()) return;
    await this.publish();
    return this.enqueue(true);
  }
  schedule(force = false) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { void this.refreshScheduled(force); }, 300);
    this.debounce.unref?.();
  }
  async refreshScheduled(force) {
    try {
      if (!this.initialized && !await this.prepare()) return;
      await this.publish();
      await this.enqueue(force);
    } catch { this.block('Automatic title coordination is unavailable; refresh after checking local storage.', true); }
  }
  enqueue(force = false) {
    if (this.disposed) return Promise.resolve();
    this.queued = true;
    this.force ||= force;
    if (!this.running) this.running = (async () => {
      while (this.queued && !this.disposed) {
        this.queued = false;
        const requested = this.force; this.force = false;
        try { await this.cycle(requested); }
        catch (error) { this.block(error.code === 'TITLE_DEAD_PENDING' ? 'A previous IDE settings write is unresolved. Fully quit the previous IDE and its background processes, relaunch, then run Disable Automatic Tab Titles for recovery.' : 'Automatic titles are blocked by ambiguous local ownership or a settings write. Check user settings and retry Disable Automatic Tab Titles.', true); }
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async fetchMetadata(ids) {
    const request = { ids, salt: this.store.salt, codexBin: this.sourceContext.binary, codexHome: this.sourceContext.codexHome };
    let timer;
    try {
      const reply = await Promise.race([this.metadata(request), new Promise((_, reject) => { timer = setTimeout(() => { this.operation?.abort?.(); reject(new Error('metadata-timeout')); }, this.options.timeout || 45000); })]);
      if (!reply || !HASH.test(reply.identity)) { const error = new Error('metadata-identity-unavailable'); error.code = 'METADATA_IDENTITY_UNAVAILABLE'; throw error; }
      if (!Array.isArray(reply.threads) || reply.threads.length > 100 || reply.threads.some(row => !ID.test(row.id) || typeof row.title !== 'string' || Array.from(row.title).length > 200)) throw new Error('metadata-invalid');
      return reply;
    } finally { clearTimeout(timer); }
  }

  async cleanup(state, reason, source = null) {
    await this.store.assertOwner();
    if (state.journal && !await this.reconcileJournal(state)) return false;
    const inspection = this.api.workspace.getConfiguration('workbench.editor.customLabels').inspect('patterns');
    if (!inspection || !inspection.globalValue || typeof inspection.globalValue !== 'object' || Array.isArray(inspection.globalValue)) {
      if (inspection?.globalValue !== undefined) throw new Error('cleanup-patterns-invalid');
    }
    const basePatterns = clone(inspection.globalValue || {});
    const patterns = { ...basePatterns };
    const entries = { ...state.entries };
    let changed = false;
    for (const [key, row] of Object.entries(entries)) if (!source || row.source === source) {
      if (patterns[key] === row.value) { delete patterns[key]; changed = true; }
      delete entries[key]; // User-edited values are preserved and relinquished.
    }
    if (changed) {
      try { await this.writePatterns(state, patterns, entries, false, basePatterns); }
      catch (error) {
        if (!['TITLE_WRITE_INVALIDATED', 'TITLE_WRITE_REJECTED'].includes(error.code)) throw error;
        state.enabled = false; state.generation++;
        state.blocked = 'Label cleanup could not complete. Automatic titles stopped; fix user settings and run Disable Automatic Tab Titles again to retry unchanged owned labels.';
        await this.store.save(state);
        this.block(state.blocked, true);
        return false;
      }
    }
    else { state.entries = entries; await this.store.save(state); }
    state.enabled = false; state.generation++; state.blocked = reason;
    await this.store.save(state);
    if (reason) this.block(reason, true); else this.setStatus('off', 'Automatic titles disabled. The whole-patterns Sync exclusion is retained.');
    return true;
  }

  async reconcileJournal(state) {
    if (!state.journal) return true;
    if (state.journal.settled !== true && this.settledJournal !== state.journal.token && this.store.recoveredJournal !== state.journal.token) {
      this.block('A previous IDE settings write may still be queued. Fully exit the previous IDE, relaunch, then run Disable Automatic Tab Titles for recovery.', true);
      return false;
    }
    await this.store.assertOwner();
    const inspection = this.api.workspace.getConfiguration('workbench.editor.customLabels').inspect('patterns');
    const actual = inspection?.globalValue || {};
    if (!inspection || typeof actual !== 'object' || Array.isArray(actual)) throw new Error('title-reconcile-patterns-invalid');
    const candidates = new Set([...Object.keys(state.entries), ...Object.keys(state.journal.intended)]);
    const reconciled = {};
    for (const key of candidates) {
      const intended = state.journal.intended[key], prior = state.entries[key];
      if (intended && actual[key] === intended.value) reconciled[key] = intended;
      else if (prior && actual[key] === prior.value) reconciled[key] = prior;
    }
    state.entries = reconciled;
    state.journal = null;
    await this.store.save(state);
    this.settledJournal = null;
    this.store.recoveredJournal = null;
    return true;
  }

  async respectUserPatterns(state) {
    const base = this.api.workspace.getConfiguration('workbench.editor.customLabels').inspect('patterns')?.globalValue || {};
    const patterns = clone(base), entries = { ...state.entries };
    let conflicts = false;
    for (const [key, row] of Object.entries(entries)) {
      if (patterns[key] !== row.value) { delete entries[key]; continue; }
      const id = key.slice('**/local/'.length);
      if (Object.keys(patterns).some(pattern => pattern !== key && !state.entries[pattern] && mayMatch(pattern, id))) {
        delete patterns[key]; delete entries[key]; conflicts = true;
      }
    }
    if (JSON.stringify(patterns) !== JSON.stringify(base)) await this.writePatterns(state, patterns, entries, false, base);
    else if (JSON.stringify(entries) !== JSON.stringify(state.entries)) { state.entries = entries; await this.store.save(state); }
    return conflicts;
  }

  async writePatterns(state, patterns, entries, additions, basePatterns, epoch) {
    await this.store.assertOwner();
    if (state.journal) throw new Error('pending-title-write');
    if (additions) {
      const privacy = this.configuration(true);
      const requests = await this.store.requests();
      if (!this.preference() || !privacy.ok || requests.some(row => row.control?.kind === 'disable' && !handled(state, row))) throw new Error('title-write-privacy-or-disable-changed');
      // Fresh snapshot inside the sole writer, immediately before persistence.
      const latest = this.configuration(true);
      if (!latest.ok) throw new Error('title-write-exclusion-changed');
    }
    const boundary = await this.boundary.capture();
    this.lastBoundary = boundary;
    state.journal = { token: randomUUID(), generation: state.generation, intended: entries, boundary };
    await this.store.save(state);
    // Finish all filesystem awaits before taking the final configuration
    // snapshot. This covers cleanup too: a manual edit must never be replaced
    // by a full patterns object constructed before the journal await.
    const requests = additions ? await this.store.requests() : [];
    const current = this.api.workspace.getConfiguration('workbench.editor.customLabels').inspect('patterns')?.globalValue || {};
    if (JSON.stringify(current) !== JSON.stringify(basePatterns) ||
        (additions && (this.disposed || this.epoch !== epoch || !this.preference() || !this.configuration(true).ok || requests.some(row => row.control?.kind === 'disable' && !handled(state, row))))) {
      state.journal = null;
      await this.store.save(state); // No configuration update was issued.
      const error = new Error('title-write-invalidated-before-update');
      error.code = 'TITLE_WRITE_INVALIDATED';
      throw error;
    }
    let rejected = false;
    try { await this.configUpdate('workbench.editor.customLabels', 'patterns', patterns); }
    catch { rejected = true; }
    // Resolution OR rejection is the completion boundary for this exact API
    // operation. Persist that fact before readback; a crash before this marker
    // remains ambiguous and cannot be reclaimed automatically.
    this.settledJournal = state.journal.token;
    state.journal.settled = true;
    await this.store.save(state);
    await this.reconcileJournal(state);
    if (rejected) { const error = new Error('title-settings-update-rejected'); error.code = 'TITLE_WRITE_REJECTED'; throw error; }
  }

  async cycle(force) {
    if (!await this.store.acquire({ recoverPending: async journal => {
      const recovery = this.recovery;
      if (!recovery || recovery.attempted) return false;
      recovery.attempted = true; recovery.refused = true;
      try {
        if (!await this.boundary.exited(journal.boundary)) return false;
        const choice = await this.api.window.showWarningMessage?.('A previous IDE settings write has an unknown outcome. Save your work, fully quit every previous instance of this IDE including background processes, and relaunch before recovering. Reloading or closing one window is insufficient. Confirm all old processes exited; surviving processes could still write settings. Cancel leaves settings and your previous title request unchanged.', { modal: true }, 'Previous IDE fully exited');
        const allowed = choice === 'Previous IDE fully exited' && await this.boundary.exited(journal.boundary);
        recovery.refused = !allowed;
        return allowed;
      } catch { return false; }
    } })) {
      const state = await this.store.state(true);
      if (state.enabled && state.source !== this.source) { this.block('This window uses a different Codex data directory or extension version. Automatic titles are paused here.'); return; }
      this.setStatus(state.blocked ? 'blocked' : state.enabled ? 'following' : 'off', state.blocked || 'Another window keeps tab titles up to date for this IDE profile.');
      return;
    }
    let state = await this.store.state(true);
    if (state.journal && !await this.reconcileJournal(state)) return;
    let requests = await this.store.requests();
    for (const instance of Object.keys(state.controls)) if (!this.store.requestInstances.has(instance)) delete state.controls[instance];
    const controls = requests.filter(row => row.control && !handled(state, row));
    const disables = controls.filter(row => row.control.kind === 'disable');
    if (disables.length) {
      for (const row of controls) state.controls[row.instance] = row.control.id;
      await this.cleanup(state, '');
      await this.configUpdate('codexSessionTabs', PREF, false);
      return;
    }
    const enabling = controls.some(row => row.source === this.source && row.control.kind === 'enable');
    if (state.enabled && !enabling && !this.preference()) { await this.cleanup(state, ''); return; }
    if (state.enabled && state.source !== this.source) {
      this.block('Another metadata context owns this profile. Disable automatic titles before switching contexts.');
      await this.store.release();
      return;
    }
    if (!state.enabled && !enabling) { this.setStatus(state.blocked ? 'blocked' : 'off', state.blocked || 'Use Enable Automatic Tab Titles to initialize this profile.'); return; }
    if (enabling) {
      for (const row of controls.filter(row => row.source === this.source && row.control.kind === 'enable')) state.controls[row.instance] = row.control.id;
      await this.store.save(state); // One explicit attempt, never a repeating consent token.
    }
    const support = await this.support();
    if (support.mode !== 'cursor' || support.source !== this.source) { await this.cleanup(state, 'The IDE/official metadata context changed. Automatic title writes stopped.', state.source); return; }
    this.sourceContext = support;
    const privacy = this.configuration(!enabling);
    if (!privacy.ok) { await this.cleanup(state, privacy.reason, state.source); return; }
    const cachedConflicts = await this.respectUserPatterns(state);
    const ids = [...new Set(requests.filter(row => row.source === this.source).flatMap(row => row.ids))].slice(0, 100);
    const signature = ids.slice().sort().join(',');
    if (enabling) {
      const current = this.configuration(false);
      if (!current.ok) { await this.cleanup(state, current.reason, state.source); return; }
      if (!current.ignored.includes(PATTERNS)) await this.configUpdate('settingsSync', 'ignoredSettings', [...current.ignored, PATTERNS]);
      const verified = this.configuration(true);
      if (!verified.ok) { await this.cleanup(state, verified.reason, state.source); return; }
      state.enabled = true; state.source = this.source; state.generation++; state.blocked = '';
      for (const row of controls) state.controls[row.instance] = row.control.id;
      await this.store.save(state);
      await this.configUpdate('codexSessionTabs', PREF, true);
    }
    if (!ids.length) { this.lastSignature = signature; this.setStatus('ready', 'Automatic titles are enabled. Open a saved official tab to discover its title.'); return; }
    if (!force && !enabling && signature === this.lastSignature) {
      if (state.blocked) this.block(state.blocked);
      else if (cachedConflicts) this.setStatus('limited', 'User label patterns were preserved; overlapping automatic labels were removed.');
      return;
    }
    this.lastSignature = signature; // An idle heartbeat never retries failures.
    const epoch = this.epoch;
    let reply;
    try { reply = await this.fetchMetadata(ids); }
    catch (error) {
      if (!this.invalidatedFetch(epoch)) {
        if (error.code === 'METADATA_IDENTITY_UNAVAILABLE') await this.cleanup(state, 'The Codex account identity is unavailable or changed. Automatic titles stopped; check the account and enable again.', state.source);
        else {
          state.blocked = 'Title metadata is temporarily unavailable. Existing labels are retained; check SDK/account/CLI and run Refresh Tab Titles to retry.';
          await this.store.save(state); this.block(state.blocked, true);
        }
      }
      return;
    }
    if (this.invalidatedFetch(epoch)) return;
    requests = await this.store.requests();
    if (requests.some(row => row.control?.kind === 'disable' && !handled(state, row))) { this.queued = true; return; }
    state.blocked = '';
    if (this.invalidatedFetch(epoch)) return;
    if (!this.configuration(true).ok) { this.queued = true; return; }
    const current = this.configuration(true);
    const patterns = { ...current.patterns };
    const entries = { ...state.entries };
    for (const [key, row] of Object.entries(entries)) {
      if (patterns[key] !== row.value) delete entries[key];
      else if (row.source === this.source && row.account !== reply.identity) { delete patterns[key]; delete entries[key]; }
    }
    const wanted = new Set(requests.filter(row => row.source === this.source).flatMap(row => row.ids));
    let conflicts = false;
    for (const row of reply.threads) {
      const id = row.id.toLowerCase();
      if (!wanted.has(id)) continue;
      const value = literalTitle(row.title);
      if (!value) continue;
      const key = `**/local/${id}`;
      const owned = entries[key];
      if (owned && (owned.source !== this.source || owned.account !== reply.identity)) { conflicts = true; continue; }
      if (Object.keys(patterns).some(pattern => pattern !== key && !entries[pattern] && mayMatch(pattern, id)) || (patterns[key] !== undefined && !owned)) {
        if (owned && patterns[key] === owned.value) { delete patterns[key]; delete entries[key]; }
        conflicts = true; continue;
      }
      if (!owned && Object.keys(entries).length >= MAX_ENTRIES) { conflicts = true; continue; }
      patterns[key] = value;
      entries[key] = { value, source: this.source, account: reply.identity };
    }
    state.account = reply.identity;
    if (JSON.stringify(patterns) !== JSON.stringify(current.patterns)) {
      try { await this.writePatterns(state, patterns, entries, true, current.patterns, epoch); }
      catch {
        state = await this.store.state(true);
        if (!state.journal) await this.cleanup(state, 'Title settings changed while metadata was pending. Automatic writes stopped; enable again explicitly.', this.source);
        else this.block('A title settings write has an unknown outcome; inspect local storage/settings before retrying.', true);
        return;
      }
    } else { state.entries = entries; await this.store.save(state); }
    this.lastSignature = signature;
    this.setStatus(conflicts ? 'limited' : 'ready', conflicts ? 'User patterns or cache capacity prevented some labels; those values were preserved.' : 'Automatic titles are active. Discovery is bounded; unknown tabs retain native labels.');
  }

  dispose() { return this.disposal ||= this.disposeInternal(); }
  async disposeInternal() {
    this.disposed = true;
    this.invalidate();
    clearInterval(this.timer); clearTimeout(this.debounce);
    await this.running;
    await this.publications;
    if (this.initialized) {
      try { await this.store.unpublish(); await this.store.release(); }
      catch { /* Pending/ambiguous ownership is deliberately retained. */ }
    }
    this.statusItem?.dispose();
  }
}

module.exports = { AutoTitles, literalTitle, mayMatch, COMMANDS, PATTERNS, PREF };
