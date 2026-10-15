'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const SDK_VERSION = '0.162.1';

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
  constructor(context, api, spawnProcess = spawn) {
    this.context = context;
    this.api = api;
    this.spawnProcess = spawnProcess;
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
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
    const decoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let eventError;
    let closed = false;
    let terminalCount = 0;
    let stopTimer;
    const promise = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        stdout += decoder.write(chunk);
        if (Buffer.byteLength(stdout, 'utf8') > 8 * 1024 * 1024) {
          eventError = new Error('Codex SDK output exceeded 8 MB.');
          child.kill();
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
            child.kill();
            return;
          }
          try {
            if (event.requestId !== requestId) throw new Error('Mismatched Codex SDK request ID');
            if (['list', 'loaded', 'renamed', 'completed', 'error'].includes(event.kind)) terminalCount++;
            if (terminalCount > 1) throw new Error('Multiple Codex SDK terminal events');
            if (event.kind === 'error') eventError = new Error(event.message);
            onEvent(event);
          } catch (error) {
            eventError = error;
            child.kill();
            return;
          }
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', reject);
      child.on('close', code => {
        closed = true;
        clearTimeout(stopTimer);
        stdout += decoder.end();
        if (stdout.trim() && !eventError) eventError = new Error('Codex SDK ended with an incomplete response.');
        if (code === 0 && !eventError && terminalCount === 1) resolve();
        else if (code === 0 && terminalCount !== 1) reject(new Error('Codex SDK ended without exactly one terminal event.'));
        else reject(eventError || new Error(stderr || `Codex SDK exited ${code}`));
      });
      child.stdin.on('error', reject);
    });
    child.stdin.write(`${JSON.stringify({ ...request, requestId })}\n`);
    return {
      promise,
      stop() {
        if (closed) return;
        child.stdin.write('{"op":"stop"}\n');
        stopTimer = setTimeout(() => child.kill(), 10000);
      },
      kill() { if (!closed) child.kill(); }
    };
  }
}

module.exports = { SdkRuntime, SDK_VERSION, runCommand };
