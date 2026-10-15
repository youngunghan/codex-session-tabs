'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const SDK_VERSION = '0.162.1';

function descendants(root, listing) {
  const children = new Map();
  for (const line of listing.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const found = [];
  const seen = new Set([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const pid = queue[index];
    for (const child of children.get(pid) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function abortProcessTree(child, platform = process.platform, spawnProcess = spawn,
  signalProcess = process.kill, listProcesses = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid='],
    { encoding: 'utf8', timeout: 1000, maxBuffer: 8 * 1024 * 1024 })) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    child.kill('SIGKILL');
    return;
  }
  if (platform === 'win32') {
    spawnProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'));
    return;
  }
  try { signalProcess(-child.pid, 'SIGSTOP'); } catch { /* Group may already have exited. */ }
  const stopped = new Set();
  for (let pass = 0; pass < 3; pass++) {
    let added = false;
    try {
      for (const pid of descendants(child.pid, listProcesses())) {
        if (stopped.has(pid)) continue;
        stopped.add(pid);
        added = true;
        try { signalProcess(pid, 'SIGSTOP'); } catch { /* Process may have exited. */ }
      }
    } catch { break; /* Fall back to the helper process group. */ }
    if (!added) break;
  }
  for (const pid of [...stopped].reverse()) {
    try { signalProcess(pid, 'SIGKILL'); } catch { /* Process may have exited. */ }
  }
  try { signalProcess(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

function runCommand(executable, args, options = {}, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; onLine(String(chunk)); });
    child.stderr.on('data', chunk => { output += chunk; onLine(String(chunk)); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output.slice(-4000) || `${executable} exited ${code}`)));
  });
}

class SdkRuntime {
  constructor(context, api, spawnProcess = spawn, abortTree = abortProcessTree) {
    this.context = context;
    this.api = api;
    this.spawnProcess = spawnProcess;
    this.abortTree = abortTree;
    this.venv = path.join(context.globalStorageUri.fsPath, `python-sdk-${SDK_VERSION}`);
    this.python = path.join(this.venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
    this.helper = path.join(context.extensionPath, 'py', 'codex_bridge.py');
    this.ready = false;
    this.installing = undefined;
  }

  async check() {
    try {
      const result = await runCommand(this.python, ['-c', 'import openai_codex; print(openai_codex.__version__)']);
      this.ready = result.trim() === SDK_VERSION;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  async install(report = () => {}) {
    if (this.installing) return this.installing;
    this.installing = this._install(report).finally(() => { this.installing = undefined; });
    return this.installing;
  }

  async _install(report) {
    const configured = this.api.workspace.getConfiguration('codexSessionTabs').get('pythonPath');
    const python = configured || (process.platform === 'win32' ? 'python' : 'python3');
    report(`Checking ${python}`);
    const version = await runCommand(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2]); assert (3, 11) <= sys.version_info[:2] <= (3, 13), "Python 3.11–3.13 is required"']);
    report(`Python ${version.trim()} found`);
    await fs.mkdir(path.dirname(this.venv), { recursive: true });
    report('Creating private Python environment');
    await runCommand(python, ['-m', 'venv', this.venv], {}, report);
    report(`Installing openai-codex ${SDK_VERSION} and its matched runtime`);
    await runCommand(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', `openai-codex==${SDK_VERSION}`], {}, report);
    if (!await this.check()) throw new Error('SDK installation completed but its version could not be verified.');
    report('Codex SDK ready');
  }

  run(request, onEvent) {
    if (!this.ready) throw new Error('Set up the Codex SDK first.');
    const requestId = randomUUID();
    const child = this.spawnProcess(this.python, ['-u', this.helper], {
      cwd: request.cwd || this.context.extensionPath, windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
    const decoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let eventError;
    let closed = false;
    let aborted = false;
    let turnSeen = false;
    let terminalCount = 0;
    let stopTimer;
    const abortTreeOnce = () => {
      if (aborted) return;
      aborted = true;
      this.abortTree(child);
    };
    const hardAbort = () => { if (!closed) abortTreeOnce(); };
    const promise = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        if (eventError) return;
        stdout += decoder.write(chunk);
        if (Buffer.byteLength(stdout, 'utf8') > 8 * 1024 * 1024) {
          eventError = new Error('Codex SDK output exceeded 8 MB.');
          hardAbort();
          return;
        }
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch (error) {
            eventError = new Error(`Invalid Codex SDK response: ${error.message}`);
            hardAbort();
            return;
          }
          try {
            if (event.requestId !== requestId) throw new Error('Mismatched Codex SDK request ID');
            if (event.kind === 'turn') turnSeen = true;
            if (['list', 'loaded', 'renamed', 'completed', 'error'].includes(event.kind)) terminalCount++;
            if (terminalCount > 1) throw new Error('Multiple Codex SDK terminal events');
            if (event.kind === 'error') eventError = new Error(event.message);
            onEvent(event);
          } catch (error) {
            eventError = error;
            hardAbort();
            return;
          }
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => { reject(error); hardAbort(); });
      child.on('close', code => {
        if (closed) return;
        closed = true;
        clearTimeout(stopTimer);
        stdout += decoder.end();
        if (stdout.trim() && !eventError) eventError = new Error('Codex SDK ended with an incomplete response.');
        if (eventError || code !== 0 || terminalCount !== 1) {
          try { abortTreeOnce(); } catch { /* Keep the original SDK error. */ }
        }
        if (eventError) reject(eventError);
        else if (code === 0 && terminalCount === 1) resolve();
        else if (code === 0) reject(new Error('Codex SDK ended without exactly one terminal event.'));
        else reject(new Error(stderr || `Codex SDK exited ${code}`));
      });
      child.stdin.on('error', error => { reject(error); hardAbort(); });
    });
    child.stdin.write(`${JSON.stringify({ ...request, requestId })}\n`);
    return {
      promise,
      stop() {
        if (closed) return;
        if (!turnSeen) { hardAbort(); return; }
        child.stdin.write('{"op":"stop"}\n');
        clearTimeout(stopTimer);
        stopTimer = setTimeout(hardAbort, 10000);
      },
      kill: hardAbort,
      abort: hardAbort
    };
  }
}

module.exports = { SdkRuntime, SDK_VERSION, runCommand, abortProcessTree };
