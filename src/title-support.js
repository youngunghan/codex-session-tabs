'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const CURSOR = Object.freeze({
  product: '50c10f58c6b1b15993eebcd7caaad99dd7206133f961ecf0e3ed2ce160e069b1',
  desktop: 'c999d13ea376bb074a6f269abeb4297d302e2ac76aa8b9cdc4af1e5bb199398b',
  glass: 'a7fd1d4c60239dbe5527117d94d7181664525c49a7a294508c59a5082e423014',
  official: '26.721.30844'
});
const hash = value => createHash('sha256').update(value).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };

async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function officialBinary(extension, platform = process.platform, arch = process.arch) {
  const target = { 'win32:x64': 'windows-x86_64/codex.exe', 'linux:x64': 'linux-x86_64/codex', 'linux:arm64': 'linux-aarch64/codex', 'darwin:x64': 'macos-x86_64/codex', 'darwin:arm64': 'macos-aarch64/codex' }[`${platform}:${arch}`];
  if (!extension?.extensionPath || !target) throw new Error('official-cli-unavailable');
  const root = await fs.realpath(extension.extensionPath);
  const binary = await fs.realpath(path.join(root, 'bin', target));
  if (!within(root, binary) || !(await fs.stat(binary)).isFile()) throw new Error('official-cli-outside-extension');
  return binary;
}

function createSupport(api, context) {
  let cached;
  return async function support() {
    if (api.env.remoteName) return { mode: 'blocked', reason: 'Automatic titles are unavailable in remote windows; official tabs remain available.' };
    if (api.env.appName !== 'Cursor') return { mode: 'native', reason: 'Official tab titles are owned by this IDE/provider; no label override is applied.' };
    if (process.platform !== 'win32' || process.arch !== 'x64' || api.version !== '1.128.0') return { mode: 'blocked', reason: 'This Cursor platform/API build has not been verified for local title settings.' };
    try {
      const appRoot = api.env.appRoot;
      const files = [path.join(appRoot, 'product.json'), path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'), path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.glass.main.js')];
      const stamps = await Promise.all(files.map(async file => { const stat = await fs.stat(file); return [stat.dev, stat.ino, stat.size, stat.mtimeMs]; }));
      const stamp = JSON.stringify(stamps);
      if (!cached || cached.stamp !== stamp) {
        const values = await Promise.all(files.map(fileHash));
        cached = { stamp, verified: values[0] === CURSOR.product && values[1] === CURSOR.desktop && values[2] === CURSOR.glass };
      }
      if (!cached.verified) throw new Error('unrecognized-build');
      const extension = api.extensions.getExtension('openai.chatgpt');
      if (!extension?.packageJSON?.contributes?.customEditors?.some(editor => editor.viewType === 'chatgpt.conversationEditor') || typeof extension.packageJSON.version !== 'string' || extension.packageJSON.version.length > 80) throw new Error('official-editor-registration-unavailable');
      const binary = await officialBinary(extension);
      const codexHome = await fs.realpath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
      const source = hash(JSON.stringify({ home: codexHome, binary, official: extension.packageJSON.version, app: CURSOR.product, profile: context.globalStorageUri.toString() }));
      return { mode: 'cursor', binary, codexHome, source, fingerprint: CURSOR.product };
    } catch {
      return { mode: 'blocked', reason: 'This Cursor/official CLI build or metadata home has not been verified. Automatic title writes are blocked.' };
    }
  };
}

module.exports = { createSupport, officialBinary, CURSOR, hash, within };
