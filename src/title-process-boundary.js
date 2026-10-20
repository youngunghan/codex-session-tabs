'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const ROLE_SCRIPT = String.raw`function RoleFacts($CommandLine, $ExecutablePath) {
  $m=[regex]::Match(([string]$CommandLine).Trim(), '^"([^\"]+)"(?:\s|$)|^(\S+)(?:\s|$)')
  $first=if($m.Groups[1].Success){$m.Groups[1].Value}else{$m.Groups[2].Value}
  $tokenMatches=$false
  if($m.Success -and $first -match '^[a-zA-Z]:[\\/]'){
    try{$tokenMatches=([IO.Path]::GetFullPath($first) -ieq [IO.Path]::GetFullPath($ExecutablePath))}catch{$tokenMatches=$false}
  }
  return @{
    initialExecutableTokenMatches=[bool]$tokenMatches
    hasElectronType=[bool]($CommandLine -match '(?i)--type(?:=|\s)')
    hasNodeMarker=[bool]($CommandLine -match '(?i)--ms-enable-electron-run-as-node|[\\/]node(?:\.exe)?(?:"|\s)')
    hasCliScript=[bool]($CommandLine -match '(?i)[\\/]cli\.(?:js|mjs|cjs)')
    hasCliOnlyFlags=[bool]($CommandLine -match '(?i)--(?:status|version|help|list-extensions|install-extension|uninstall-extension|locate-extension)(?:=|\s|$)')
  }
}`;

function executablePath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[a-z]:[\\/]/i.test(value) || /[<>"|?*\x00-\x1f]/.test(value) || value.slice(2).includes(':')) throw new Error('process-path-ambiguous');
  return path.win32.normalize(value).toLowerCase();
}
function identity(row) {
  if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.ticks !== 'string' || !/^\d{18,19}$/.test(row.ticks) || BigInt(row.ticks) < 621355968000000000n || BigInt(row.ticks) > 3155378975999999999n) throw new Error('process-identity-ambiguous');
  return { pid: row.pid, ticks: row.ticks, executable: executablePath(row.executable) };
}
function owningMain(snapshot, expectedExecutable, currentPid) {
  if (snapshot?.complete !== true) throw new Error('process-query-incomplete');
  const current = identity(snapshot.current), parent = identity(snapshot.parent);
  const expected = executablePath(expectedExecutable);
  if (!['code.exe', 'cursor.exe'].includes(path.win32.basename(expected)) || current.pid !== currentPid || current.executable !== expected || current.pid === parent.pid || snapshot.current.parent !== parent.pid || parent.executable !== expected || snapshot.parent.mainRole !== true || BigInt(parent.ticks) > BigInt(current.ticks)) throw new Error('direct-ide-main-unverified');
  // Deliberately stop here. A main process may have a dead parent or a transient
  // same-executable CLI launcher; neither is the owner of its settings queue.
  return parent;
}
function mainExited(snapshot, recorded, expectedExecutable, currentPid) {
  const old = identity(recorded);
  const currentMain = owningMain(snapshot, expectedExecutable, currentPid);
  if (old.pid === snapshot.current.pid || old.pid === currentMain.pid) return false;
  if (snapshot.previous === null) return true; // Successful exact-PID query.
  const present = identity(snapshot.previous); // Malformed != positively dead.
  if (present.pid !== old.pid) throw new Error('previous-process-query-mismatch');
  return present.ticks !== old.ticks || present.executable !== old.executable;
}

function readSnapshot(previousPid, options = {}) {
  const pid = options.pid || process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || (previousPid !== undefined && (!Number.isSafeInteger(previousPid) || previousPid <= 0))) return Promise.reject(new Error('process-query-pid-invalid'));
  if ((options.platform || process.platform) !== 'win32') return Promise.reject(new Error('process-query-platform-unverified'));
  const shell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Query only the host, its direct parent, and optional old main. Command-line
  // role detection stays inside PowerShell RAM and never leaves this helper.
  const script = `$ErrorActionPreference='Stop'
${ROLE_SCRIPT}
function Row($ProbePid, $Role) {
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProbePid) -ErrorAction Stop
  if($null -eq $p){return $null}
  $ticks=$null
  if($null -ne $p.CreationDate){$ticks=$p.CreationDate.ToUniversalTime().Ticks.ToString()}
  $main=$false
  $facts=$null
  if($Role){
    $facts=RoleFacts $p.CommandLine $p.ExecutablePath
    $main=$facts.initialExecutableTokenMatches -and -not ($facts.hasElectronType -or $facts.hasNodeMarker -or $facts.hasCliScript -or $facts.hasCliOnlyFlags)
  }
  return @{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;ticks=$ticks;executable=$p.ExecutablePath;mainRole=[bool]$main;roleFacts=$facts}
}
$current=Row ${pid} $false
if($null -eq $current){throw 'current unavailable'}
$parent=Row $current.parent $true
$previous=${previousPid === undefined ? '$null' : `Row ${previousPid} $false`}
@{complete=$true;current=$current;parent=$parent;previous=$previous}|ConvertTo-Json -Compress -Depth 4`;
  return new Promise((resolve, reject) => {
    (options.execFile || execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(new Error('process-query-unavailable')); return; }
      try { const value = JSON.parse(stdout.replace(/^\uFEFF/, '')); if (value.complete !== true) throw new Error(); resolve(value); }
      catch { reject(new Error('process-query-invalid')); }
    });
  });
}
function createProcessBoundary(options = {}) {
  const pid = options.pid || process.pid, executable = options.executable || process.execPath;
  const snapshot = options.snapshot || (old => readSnapshot(old));
  return {
    async capture() { return owningMain(await snapshot(), executable, pid); },
    async exited(recorded) { return mainExited(await snapshot(recorded.pid), recorded, executable, pid); }
  };
}
module.exports = { createProcessBoundary, readSnapshot, identity, owningMain, mainExited, ROLE_SCRIPT };
