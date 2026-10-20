'use strict';
const { readSnapshot, identity, owningMain } = require('../../src/title-process-boundary');
async function main() {
  if (process.argv.length !== 2) throw new Error('no-arguments-supported');
  const snapshot = await readSnapshot();
  const current = identity(snapshot.current);
  if (current.pid !== process.pid) throw new Error('self-identity-mismatch');
  let parentValid = false, ideMain = false;
  try { identity(snapshot.parent); parentValid = true; } catch { /* Negative eligibility is fail-closed. */ }
  try { owningMain(snapshot, process.execPath, process.pid); ideMain = true; } catch { /* A regular Node gate process is not an IDE host. */ }
  console.log('PROCESS_BOUNDARY_RESULT', JSON.stringify({ status: 'completed', selfIdentityVerified: true, directParentIdentityVerified: parentValid, directIdeMainVerified: ideMain, rawProcessDataEmitted: false }));
}
main().catch(() => { console.error('PROCESS_BOUNDARY_RESULT', JSON.stringify({ status: 'failed', classification: 'process-identity-unavailable', rawProcessDataEmitted: false })); process.exitCode = 1; });
