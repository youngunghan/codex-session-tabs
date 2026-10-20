'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createWritableFinalizer } = require('./writable-files');
const apps = {
  cursor: { executable: 'C:/Users/hyuli/AppData/Local/Programs/cursor/Cursor.exe', manifest: 'C:/Users/hyuli/AppData/Local/Programs/cursor/resources/app/package.json', official: 'C:/Users/hyuli/.cursor/extensions/openai.chatgpt-26.721.30844-win32-x64' },
  code: { executable: 'C:/Users/hyuli/AppData/Local/Programs/Microsoft VS Code/Code.exe', manifest: 'C:/Users/hyuli/AppData/Local/Programs/Microsoft VS Code/6d62b1d5da/resources/app/package.json', official: 'C:/Users/hyuli/.vscode/extensions/openai.chatgpt-26.1007.21434-win32-x64' }
};
async function main() {
  const app = process.argv[2];
  if (!apps[app] || process.argv.length !== 3) throw new Error('Usage: node test/compat/run-product-titles.js cursor|code');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-product-titles-${app}-`));
  const finalize = createWritableFinalizer(root);
  const home = path.join(root, 'home'), workspace = path.join(root, 'FAKE-title-test');
  for (const item of [workspace, home, ...['AppData', 'LocalAppData', 'Temp', '.codex'].map(name => path.join(home, name))]) fs.mkdirSync(item);
  const env = {};
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'programfiles', 'programfiles(x86)', 'programw6432', 'systemdrive', 'processor_architecture', 'number_of_processors']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  const reportPath = path.join(root, 'report.json');
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'LocalAppData'), TEMP: path.join(home, 'Temp'), TMP: path.join(home, 'Temp'), TITLE_SOURCE_ROOT: path.resolve(__dirname, '../..'), TITLE_GENERATED_ROOT: root, TITLE_APP: app, TITLE_REPORT: reportPath, TITLE_OFFICIAL_PATH: apps[app].official, TITLE_PRODUCT_VERSION: JSON.parse(fs.readFileSync(apps[app].manifest, 'utf8')).version });
  const args = [workspace, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions', '--user-data-dir', path.join(root, 'user'), '--extensions-dir', path.join(root, 'extensions'), `--extensionDevelopmentPath=${path.join(__dirname, 'product-probe')}`, `--extensionTestsPath=${path.join(__dirname, 'product-probe/tests.js')}`];
  console.log('PRODUCT_TITLE_PROBE', JSON.stringify({ app, root, fakeProvider: true, fakeMetadata: true, executable: apps[app].executable, args }));
  let closed = false;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(apps[app].executable, args, { env, stdio: 'inherit', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); }, 120000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { closed = true; clearTimeout(timer); resolve(code); });
    });
    console.log('PRODUCT_TITLE_PROCESS', JSON.stringify({ exitCode }));
    if (!fs.existsSync(reportPath)) throw new Error('Product title probe report missing');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    console.log('PRODUCT_TITLE_RESULT', JSON.stringify(report));
    if (exitCode !== 0 || report.status !== 'completed' || !report.probeFinished || report.mode !== app || !report.fakeProvider || !report.fakeMetadata || !report.defaultOffNoMetadata || (app === 'cursor' ? !report.inactiveLabelMatchesFakeMetadata || !report.exclusionVerified || !report.removalCleanedOwnedValues || !report.removalBlockedWithoutReadding : !report.nativeTitlePreserved || !report.noMetadataOrPatternOverride)) throw new Error('Product title probe failed or incomplete');
  } finally {
    if (closed) console.log('PRODUCT_TITLE_WRITABLE_FILES', JSON.stringify(finalize()));
    else console.log('PRODUCT_TITLE_WRITABLE_FILES', JSON.stringify({ skipped: 'owned-process-not-closed' }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
