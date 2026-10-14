'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function executableCommand(configuredPath = '', env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  const roots = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = configuredPath ? [configuredPath] : roots.flatMap(root => names.map(name => path.join(root, name)));
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (/\.(cmd|bat)$/i.test(candidate)) {
      const script = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(script)) return { command: process.execPath, args: [script, 'app-server', '--listen', 'stdio://'] };
      continue;
    }
    return { command: candidate, args: ['app-server', '--listen', 'stdio://'] };
  }
  throw new Error(configuredPath
    ? `Codex executable not found or unsupported: ${configuredPath}`
    : 'Codex CLI not found on PATH. Install @openai/codex or set codexSessionTabs.executablePath.');
}

class AppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.starting = null;
    this.disposed = false;
  }

  async start() {
    if (this.disposed) throw new Error('Codex connection is closed.');
    if (this.starting) return this.starting;
    if (this.process && this.process.exitCode === null) return;
    this.starting = this._start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async _start() {
    const { command, args } = this.options.commandSpec || executableCommand(this.options.executablePath, this.options.env, this.options.platform);
    const child = spawn(command, args, {
      cwd: this.options.cwd || process.cwd(),
      env: this.options.env || process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    let recentError = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      recentError = (recentError + chunk).slice(-3000);
      this.emit('diagnostic', chunk);
    });
    readline.createInterface({ input: child.stdout }).on('line', line => this._receive(line));
    child.on('error', error => this._stop(error));
    child.on('exit', (code, signal) => this._stop(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}). ${recentError}`.trim())));
    try {
      await this.request('initialize', {
        clientInfo: { name: 'codex_session_tabs', title: 'Codex Session Tabs', version: '0.1.0' }
      }, 20000);
      this.notify('initialized', {});
    } catch (error) {
      child.kill();
      this._stop(error);
      throw error;
    }
  }

  request(method, params = {}, timeoutMs = 30000) {
    if (!this.process || this.process.exitCode !== null) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._write({ method, id, params });
    });
  }

  notify(method, params = {}) { this._write({ method, params }); }

  respond(id, result) { this._write({ id, result }); }

  respondError(id, message) { this._write({ id, error: { code: -32601, message } }); }

  _write(message) {
    if (!this.process || this.process.exitCode !== null) throw new Error('Codex app-server is not running.');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.emit('diagnostic', `Invalid JSON from Codex: ${line.slice(0, 300)}\n`); return; }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) this.emit('serverRequest', message);
    else if (message.method) this.emit('notification', message);
  }

  _stop(error) {
    if (!this.process) return;
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('stopped', error);
  }

  dispose() {
    this.disposed = true;
    if (this.process) {
      this.process.kill();
      this._stop(new Error('Codex connection closed.'));
    }
  }
}

module.exports = { AppServer, executableCommand };
