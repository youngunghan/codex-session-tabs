'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { owningMain, mainExited, identity, readSnapshot, createProcessBoundary, ROLE_SCRIPT } = require('../src/title-process-boundary');
const executable = 'C:\\Test IDE\\Cursor.exe';
const ticks = '638000000000000000';
const row = (pid, extra = {}) => ({ pid, parent: 1, ticks, executable, mainRole: true, ...extra });
const snapshot = previous => ({ complete: true, current: row(30, { parent: 20, ticks: '638000000000000002', mainRole: false }), parent: row(20, { parent: 10 }), previous });

test('direct main is chosen without climbing to an outer CLI launcher or requiring main parent to exist', () => {
  const value = snapshot(null);
  assert.equal(owningMain(value, executable, 30).pid, 20);
  value.parent.parent = 999999; // Dead parent/launcher outside the boundary.
  assert.equal(owningMain(value, executable, 30).pid, 20);
  value.parent.mainRole = false; // Direct CLI/utility is never a main.
  assert.throws(() => owningMain(value, executable, 30), /unverified/);
});

test('reused or younger direct parent and incomplete/current PID mismatch fail closed', () => {
  const value = snapshot(null); value.parent.ticks = '638000000000000003';
  assert.throws(() => owningMain(value, executable, 30), /unverified/);
  assert.throws(() => owningMain({ ...snapshot(null), complete: false }, executable, 30), /incomplete/);
  assert.throws(() => owningMain(snapshot(null), executable, 31), /unverified/);
  assert.throws(() => owningMain(snapshot(null), 'C:\\Node\\node.exe', 30), /unverified/);
});

test('root alive or same owning main rejects; positive absence and valid PID reuse permit prerequisite', () => {
  const old = row(5);
  assert.equal(mainExited(snapshot(row(5)), old, executable, 30), false);
  assert.equal(mainExited(snapshot(null), row(20), executable, 30), false);
  assert.equal(mainExited(snapshot(null), row(30), executable, 30), false);
  assert.equal(mainExited(snapshot(null), old, executable, 30), true);
  assert.equal(mainExited(snapshot(row(5, { ticks: '638000000000000001' })), old, executable, 30), true);
});

test('malformed, missing, truncated timestamp and inaccessible/unusable paths are ambiguous, not dead', () => {
  const old = row(5);
  for (const invalid of [null, NaN, 638000000000000000, 'NaN', '63800000000000000', '000000000000000000', '9999999999999999999']) {
    assert.throws(() => mainExited(snapshot(row(5, { ticks: invalid })), old, executable, 30), /ambiguous/);
  }
  for (const invalid of [null, undefined, '', 'relative.exe', 'C:\\invalid?\\Cursor.exe', 'C:\\x\0.exe']) {
    assert.throws(() => mainExited(snapshot(row(5, { executable: invalid })), old, executable, 30), /ambiguous/);
  }
  assert.throws(() => mainExited({ ...snapshot(null), previous: undefined }, old, executable, 30), /ambiguous/);
  assert.throws(() => identity(row(NaN)), /ambiguous/);
});

test('query failures/truncated JSON are fixed errors; verified boundary uses fresh snapshots each check', async () => {
  const query = (error, output) => (_file, _args, options, callback) => { assert.equal(options.timeout, 3000); assert.equal(options.windowsHide, true); callback(error, output); };
  await assert.rejects(readSnapshot(undefined, { platform: 'win32', execFile: query(new Error('PRIVATE SECRET'), '') }), error => error.message === 'process-query-unavailable');
  await assert.rejects(readSnapshot(undefined, { platform: 'win32', execFile: query(null, '{') }), /query-invalid/);
  let calls = 0;
  const boundary = createProcessBoundary({ pid: 30, executable, snapshot: async () => { calls++; return snapshot(null); } });
  assert.equal((await boundary.capture()).pid, 20);
  assert.equal(await boundary.exited(row(5)), true); assert.equal(await boundary.exited(row(5)), true);
  assert.equal(calls, 3);
});

test('actual PowerShell role regex handles quoted main and rejects CLI/utility/node forms', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('node:child_process');
  const cases = [
    { command: `"${executable}" --new-window --extensionTestsPath=C:\\test\\tests.js`, exe: executable },
    { command: 'C:\\Cursor\\Cursor.exe --new-window', exe: 'C:\\Cursor\\Cursor.exe' },
    { command: 'C:/Cursor/Cursor.exe --new-window', exe: 'C:\\Cursor\\Cursor.exe' },
    { command: `"${executable}" --type=utility`, exe: executable },
    { command: `"${executable}" --ms-enable-electron-run-as-node`, exe: executable },
    { command: `"${executable}" "C:\\Cursor\\resources\\app\\out\\cli.js"`, exe: executable },
    { command: `"${executable}" --status`, exe: executable }
  ];
  const encoded = Buffer.from(JSON.stringify(cases)).toString('base64');
  const script = `${ROLE_SCRIPT}\n$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json\n$results=@(foreach($case in $cases){RoleFacts $case.command $case.exe});$results|ConvertTo-Json -Compress`;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 3000, encoding: 'utf8' }));
  const eligible = facts => facts.initialExecutableTokenMatches && !facts.hasElectronType && !facts.hasNodeMarker && !facts.hasCliScript && !facts.hasCliOnlyFlags;
  assert.deepEqual(result.map(eligible), [true, true, true, false, false, false, false]);
  assert.ok(ROLE_SCRIPT.includes('(?:\\s|$)')); assert.ok(!ROLE_SCRIPT.includes('(?:\\\\s|$)'));
});
