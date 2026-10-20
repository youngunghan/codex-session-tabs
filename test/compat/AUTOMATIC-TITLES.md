# Automatic titles: implementation and evidence

Working version: 0.6.3, branch `feat/official-auto-titles-20261020`, base `e2449c0bd9580193e9062b8cac445d603d0b154b`. This is a review handoff, not an installed or published release. Requested author lane is Sol/high; actual runtime author metadata is unavailable and unverified. Independent review/execution acceptance is handled separately by the parent session.

## Capability boundary

- Automatic titles default off, with no SDK installation, title filesystem setup, or title settings mutation on default activation. The existing official opener and preview pinning remain independent.
- Only the verified local Windows x64 Cursor 3.25.9/API 1.128.0 fingerprint permits pattern writes. SHA-256 fingerprints cover `product.json`, desktop and glass workbench bundles in `src/title-support.js`. Unknown builds/platforms and remote windows fail closed. Official extension versions are context inputs rather than an arbitrary version allowlist: the contributed editor, contained bundled CLI, and typed public SDK responses must be valid.
- Other IDEs preserve provider labels with no automatic metadata request or override. Existing real saved-thread evidence observed the SDK name as the native VS Code 1.142 label. This does not establish native naming behavior for every IDE/provider version.
- Public SDK 0.162.1 uses the corresponding official bundled CLI and existing CODEX_HOME. The new operation calls account with refresh disabled, up to three thread-list pages of 50, then account again. It never starts/resumes/renames a thread, reads turns, or sends a model turn. Only open canonical official `/local/<UUID>` IDs are eligible; names are preferred, with a bounded first preview line fallback. Unknown IDs remain native.
- Email normalization and salted HMAC happen in helper RAM. The per-profile salt, HMAC, source context, IDs and owned labels are local storage; no email, authentication objects, messages or drafts are stored by this feature. Identity is a login discriminator, not organization/workspace authentication. New-operation errors and runtime stderr fallback have fixed public diagnostics, tested with secret-bearing exception strings. The official SDK/CLI may maintain their own logs/configuration.

## Settings and coordination

Explicit Enable is consent to exclude the **entire** `workbench.editor.customLabels.patterns` value from Settings Sync, including unrelated user labels. It preserves other exclusions and verifies fresh Global and effective configuration snapshots. Negative exclusion aliases, workspace/language overrides, unregistered settings and disabled custom labels block writes. Removing the exclusion invalidates pending metadata, blocks new writes, and attempts cleanup of unchanged owned values. Explicit Enable is required to restore exclusion; Disable retains it.

Titles are literal, control characters removed, at most 120 UTF-16 units without splitting a Unicode code point. The 250-entry cache skips new mappings at capacity and retains cached absent mappings. User values/overlapping patterns are preserved; edited owned values are relinquished.

Cooperative windows share one filesystem writer and per-instance request/control files under the extension's profile global storage. Followers publish compatible source-context IDs; they do not query metadata or write configuration. Different contexts block. Debounce is 300 ms and coordination heartbeat is two seconds. The heartbeat never polls metadata for unchanged IDs, even after 30 seconds; zero IDs never launch a helper. A changed eligible ID set (including newly published compatible follower IDs) and explicit Enable/Refresh can fetch metadata, bounded at 45 seconds. Settings/ownership cleanup runs independently. A transient transport/timeout error retains same-context enabled state/cache/exclusion with a generic actionable Refresh retry status; unknown identity or context change still cleans unchanged old-context values. Ownership is not based on age or `globalState` compare-and-set. Ambiguous liveness/bootstrap/corrupt state blocks.

The writer journals before a settings update. After every filesystem await it rechecks the final patterns baseline and, for additions, epoch/preference/privacy/pending disable before posting the update. Both additions and cleanup abort an unissued journal if a user edit changed the base. Configuration writes already posted through the public API cannot be atomically compared-and-set against later manual edits or third-party writers; that narrow race remains. Shutdown waits for in-flight configuration/publications before releasing ownership. Cooperative filesystem ownership is not a tamper-proof security boundary.

After the exact update promise resolves **or rejects**, the writer persists a settled marker, compares fresh Global values against prior owned and intended entries, preserves/relinquishes user changes, and clears the settled journal. Rejected/no-write and applied-then-rejected operations are not reported as success; a later Disable/privacy cleanup can retry without a permanent journal trap. If persistence fails before the settled marker is durable, the interrupted journal remains ambiguous. A dead writer with a durable settled marker can be replaced and reconciled, while an unresolved journal is never reclaimed automatically.

Before a title journal posts a settings update, a bounded Windows CIM query captures the direct owning IDE main's PID, exact creation ticks and normalized executable identity. It inspects only the host/direct parent, never climbing to an outer CLI launcher. Main role is classified from the parent's command line in RAM; command-line text is never returned or stored. Each query has a three-second/64-KB bound. Invalid, missing, inaccessible, malformed or incomplete identity is ambiguous. The owning main's own parent can be gone and is intentionally outside this boundary.

Only explicit **Disable** can request unresolved dead-writer recovery. The old writer must be positively dead; the recorded main must be verified exited and neither current host nor current direct main. Same-main extension-host restart, alive/ambiguous main and unsupported layouts refuse before consent. After these checks a modal confirmation requires the user to attest that **all** previous IDE instances/background processes exited; closing one window or reloading does not qualify. Main exit alone does not prove surviving descendants drained their queue. The helper repeats the check after consent, then acquisition rechecks the exact lock/owner/journal and uses the exclusive reclaim claim. Exact prior/intended values are reconciled before Disable cleanup, preserving edited values and the Sync exclusion. The remaining descendant boundary is a user attestation, not an automated proof or security guarantee against incorrect confirmation. No user window is closed/killed by recovery. A missing legacy boundary remains blocked.

Cursor's inspected bundled VS Code Sync store is disabled. Both custom-label settings have window scope and lack `ignoreSync`; the public API exposes no machine-local configuration target for them. The exclusion is therefore required. No guarantee is made about separate Cursor cloud transfer or third-party sync tools. Labels and IDs exist in generated or real Global settings when enabled; users should treat those local settings as sensitive.

## Reproducible checks

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
npm test
$env:TEMP='D:/ctg'; $env:TMP='D:/ctg'
node test/compat/run-product-titles.js cursor
node test/compat/run-product-titles.js code
node test/compat/check-process-boundary.js
```

The builtin-only IDE launcher creates an empty profile/workspace/home/CODEX_HOME and an OS-runtime environment allowlist. It loads only a clearly **FAKE** custom provider and injected fake metadata, then runs the production manager with real public configuration and Tab APIs. It inspects the installed official manifest/path for the real support checker, without loading that extension. It does not copy credentials, settings or tabs. A test-only six-second Cursor startup grace avoids the earlier very-early-exit harness race; it is not renderer readiness or a product delay. Any nonzero IDE root exit or missing completion marker fails. Timeout kills only its owned root; descendants after abnormal termination rely on the enclosing verifier job or manual inspection of that generated fixture. No broad process kill is used.

Generated profiles/reports remain outside the checkout. After normal root closure the accepted contained writable-file normalizer from Stage A `44d8db2` clears readonly metadata only for single-link regular files inside the captured generated root, skipping symlinks/junctions/hardlinks. It performs no deletion. Windows short TEMP avoids long-path cleanup failures. IDE/SDK startup can make network requests/bootstrap plugin Git files even without turns; this is **not network isolation**.

Observed at initial e781751 handoff on 2026-10-20 (before the repair below):

| Check | Actual result |
|---|---|
| Full Node regression | 104 tests: 99 passed, five platform skips, zero failures; later two manager risk tests passed in targeted run (28/28 manager+metadata) |
| Cursor fake-provider integration | Root exit 0; completed; inactive fake SDK label matched; exclusion verified; exclusion removal cleaned owned values, preserved user pattern, remained blocked without re-adding |
| VS Code fake-provider integration | Root exit 0; completed; meaningful fake native inactive title preserved; zero metadata calls, no pattern/Sync override |
| New product runtime + real SDK/official Cursor CLI | Exit 0; SDK 0.162.1; account available; one requested saved row matched; name hash matched private selection; metadata-only request, no model-turn request |

The redacted real driver requires explicit local authorization and existing private inputs:

```text
node test/compat/check-real-metadata.js --python <existing SDK Python> --codex-home <existing CODEX_HOME> --selection-file <private JSON with id/name> --binary <official bundled CLI>
```

It uses the actual product `SdkRuntime` and bridge, holding raw reply/selection/HMAC in RAM. Output is booleans/count/SDK version or a fixed failure classification; it never prints raw IDs, titles, emails, helper stderr or exceptions. It reads CODEX_HOME in place, without copying authentication. The final external task binds the authorized machine paths privately.

Deterministic tests cover single-writer races/takeover, pending-journal dead writer, two-manager union, incompatible followers, follower disable during metadata, delayed publications/disposal, disable during an awaited configuration write, exclusion removal and delayed-journal user edits for both additions and cleanup, account changes, privacy conflicts, full cache/no eviction, Unicode and near-capacity doubled journal readability, metadata framing and secret-bearing failures. Actual two-process IDE coordination was not exercised; the two-manager shared-filesystem test is separate evidence.

The first independent review returned CHANGES (session `151abbef-9de9-4ff2-9a76-1420d3fdeb3f`) for the permanent journal trap and idle polling/transient disable. The bounded recovery addendum received L0 Opus/high PASS (`b8a26b78-ff75-40a4-967b-db44cc5209f4`). Repair-focused tests cover settled rejected/no-write/applied/user-edit reconciliation, subsequent Disable and exclusion removal, durable settled takeover, canceled/automatic/live/ambiguous/same-main/recheck recovery rejection, verified-main-plus-attested recovery, no overlap while a prior update is pending, idle past 30 seconds, zero tabs, new follower IDs, transient retry, malformed timestamps/paths, CLI-parent boundaries and real read-only CIM parsing. The real Node CIM smoke completed with self/direct-parent identity verified and IDE eligibility false, as expected for a shell-launched Node process; no raw process data was emitted. Full suite and current actual IDE verification remain mandatory at the new bound handoff.

Author repair evidence: 56 focused manager/store/metadata/boundary tests passed, followed by six boundary tests including actual PowerShell role-regex execution for quoted/unquoted paths, slash equivalence and CLI/utility/node rejection. Initial Cursor ancestry attempts failed safely with root exit 1: direct parent executable/link/order matched, but raw initial command-line token comparison did not normalize the launcher's forward slashes against CIM backslashes. Boolean-only diagnosis preserved those failures. After lexical absolute-path normalization, one focused Cursor rerun root-exited 0 with completed marker, verified direct main captured and used in title journals, inactive fake metadata label match, exclusion verification and removal cleanup all true, metadataCalls=1. No arbitrary ancestry traversal was added. The mandatory frozen verification will supply the final full suite/Code/real-metadata evidence; this author did not repeat those broad checks after repair.

## Prior real-chat provenance and remaining limits

Frozen test-only source `5b45775d0f8dd05eb32f293040130cf128ad22e4` (base accepted Stage A `44d8db25b03242c8343a6c7a23f317aebedd7ac6`) contains the separate saved-thread diagnostic. Current official versions inspected there: Cursor 26.721.30844/CLI 0.146.0-alpha.3 and VS Code 26.1007.21434/CLI 0.162.0-alpha.17.2. Existing canonical saved names matched inactive tab labels through actual host APIs on both products. Parent native Code observation saw the same saved name, actual messages and composer; no message was sent or authentication interaction performed. Cursor native GUI observation was blocked by fresh-profile onboarding. No protocol renderer-ready event was observed. Those private generated fixtures contain actual IDs/titles and are not copied into this repository.

Earlier sync-only Cursor runs completed API restoration but root-exited 4294930433, remaining INCOMPLETE evidence. Later saved probes and this fake product integration root-exited 0; the failures were not reclassified. Current product tests prove manager configuration/Tab behavior with a fake provider, not official renderer recovery/readiness. The real bridge check proves the new metadata code path separately.

Remote, Linux/macOS, future upgrades, cloud/organization identity and actual two-window IDE handoff remain unverified. Automatic startup-error recovery, closing/reopening official panels, draft handling and the previously reported send/file-link failures are outside this feature.
