'use strict';
// Explicitly authorized diagnostic: read existing CODEX_HOME in place. Raw
// selection, helper output and account HMAC remain in RAM, never in diagnostics.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { SdkRuntime } = require('../../src/runtime');
const { ID, HASH } = require('../../src/title-store');
async function main() {
  const options = {};
  const names = ['--python', '--codex-home', '--selection-file', '--binary'];
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    if (!names.includes(key) || options[key] || !value || !path.isAbsolute(value)) throw new Error('invalid-arguments');
    options[key] = value;
  }
  if (names.some(key => !options[key])) throw new Error('missing-explicit-diagnostic-path');
  const selected = JSON.parse(fs.readFileSync(options['--selection-file'], 'utf8'));
  if (!ID.test(selected.id) || typeof selected.name !== 'string' || !selected.name.trim()) throw new Error('invalid-private-selection');
  const runtime = new SdkRuntime({ globalStorageUri: { fsPath: path.dirname(options['--python']) }, extensionPath: path.resolve(__dirname, '../..') }, {});
  runtime.python = options['--python'];
  let reply;
  const operation = runtime.run({ op: 'metadata', ids: [selected.id], salt: randomBytes(32).toString('hex'), codexBin: options['--binary'], codexHome: options['--codex-home'] }, event => { if (event.kind === 'metadata') reply = event; });
  const timer = setTimeout(() => operation.abort(), 45000);
  try { await operation.promise; } finally { clearTimeout(timer); }
  const row = reply?.threads?.find(item => item.id.toLowerCase() === selected.id.toLowerCase());
  const digest = value => createHash('sha256').update(value).digest('hex');
  const result = {
    status: 'completed', accountAvailable: HASH.test(reply?.identity || ''),
    requestedRowMatched: Boolean(row), titleHashMatchesSelection: Boolean(row && digest(row.title) === digest(Array.from(selected.name).slice(0, 200).join(''))),
    returnedCount: reply?.threads?.length || 0, sdkVersion: reply?.sdkVersion,
    metadataOnlyRequest: true, modelTurnRequestSent: false
  };
  if (!result.accountAvailable || !result.requestedRowMatched || !result.titleHashMatchesSelection || result.sdkVersion !== '0.162.1') throw new Error('metadata-semantic-check-failed');
  console.log('REAL_METADATA_RESULT', JSON.stringify(result));
}
main().catch(() => { console.error('REAL_METADATA_RESULT', JSON.stringify({ status: 'failed', classification: 'metadata-diagnostic-unavailable', rawDetailsRedacted: true })); process.exitCode = 1; });
