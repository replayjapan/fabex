# Fabex 1.8.0 acceptance matrix

Run `pnpm test` from the repository. Tests use isolated state and mocked SDK events: they demonstrate routing and lifecycle logic, not real phone delivery, hosted model behavior, or resource stability. Existing regression suites remain required. No release is declared live-verified solely from test counts.

## Automated checks

New named tests live in `tests/unit/regressions-1.8.test.mjs`:

| Test name (prefix `1.8 `) | Acceptance |
| --- | --- |
| upload matrix: ordinary and mode-command photos reach Phase 1 in work discussion ask | Six entry/route combinations, two images, Unicode/multiline owner text, no current Fable commentary, correct sandbox and same canonical Phase 2 thread; nested repository fixture |
| image-only and Codex-only submissions preserve empty words; Claude-only stays excluded | Empty owner string, captured empty digest, single-turn image JSON, mode image without caption, no empty text-only request, Claude-only exclusion |
| pending mode attachments survive state reload and cancel old work before read-only execution | Paused grant persists paths and reserved operation; cancelled old work never calls SDK; replacement uses read-only |
| invalid mode upload retains grant and text; cancellation clears paths and retry IDs deduplicate | No grant consumption or text loss, identical request-ID replay, conflicting reuse, new repeated-caption request, cancelled-path erasure |
| submission and runner lock contention retry without stealing a live lock | Live fixture lock released after 200 ms; submit and runner claim succeed |
| ask return ignores notifications and unknown destination fails closed without a grant | Notifications do not consume ask; missing return goes discussion/both with unknown owner mode and visible warning |
| ask selected without text waits for its first ordinary image question | A no-argument both/Codex ask selection is not consumed before its first submitted question; later genuine owner input returns to the proven prior mode |
| recorded replies are exact session-bound bounded and excluded from recovery seeds | Quotes/JSON/newlines retained, overflow unavailable, foreign-session and Claude-only text not injected |
| relay command emits only the unmodified block and is guard-allowed | CLI output equals relayBlock byte-for-byte, no JSON wrapper |
| guards preserve image denial during trouble and permit only healthy external scratch writes | Corruption/lock/migration image reads denied; permitted scratch writes, forbidden project/unapproved paths and symlink escapes; no discussion builds |
| exact read diagnostics do not grant Git delivery or environment dumps | Tag list, disk size and bounded process fields allowed; tag creation, commit composition, environment/argument dumps and tee denied |
| schema 12 migration retains queued images pending grants reply digests and canonical identity | Lossless active data migration to schema 13; added fields default safely |
| cleanup refuses symlinks unique files wrong names and active use before removal | Full file/ref audit, injected active-use refusal, positive inspection; OS lsof still requires live verification |
| missing pending image never becomes a text-only operation and retained grant remains retryable | Terminal old operation records visible warning; no replacement starts without image; restored file allows same paused grant |

Existing regression checks remain part of the gate:

- `1.7.2 phone size bound is 16 MiB, with six-image and format limits retained`: oversized/empty/unsupported images and seven-image rejection.
- `1.7.2 sibling-session uploads and missing or ambiguous hook evidence fail closed` and `1.7.2 upload file and session-directory symlink escapes remain denied`: no cross-session or symlink-root broadening.
- `1.7.2 explicit failed submit reports per-path status and never queues a text-only fallback` and `1.7.2 failed or cancelled SDK turns never claim delivered; Fable image reads stay denied`: all-or-nothing input and truthful delivery metadata.
- Existing 1.6/1.6.1/1.7 regression suites cover owner grants, notification filtering, two-phase barriers, cancellation/recovery, migration-deferred live-runner protection and full-answer versus truncated-answer Stop behavior.
- Existing controller, guard and state suites cover canonical ID mismatch, exact resume, fail-closed recovery and operational-only Git delivery. Every existing test must remain green; do not remove a security assertion to pass this release.
- Package tests check version/lockfile pins, packaged files and public-tree privacy. Also run `git diff --check` and `claude plugin validate .`.

## Live checks after delivery, update, reload and restart

These are **pending**, not inferred from mocked SDK tests. Fable coordinates and records observed outcomes; Codex reviews images independently. Ask the owner only for host interactions that cannot be performed by the framework.

| Check | Owner action / coordinator observation |
| --- | --- |
| Activation and labels | Owner updates/reloads and restarts; coordinator runs diagnose, verifies source/registry and actual recorded-turn version, confirms labels from available model metadata |
| Phone ordinary-message matrix | Owner selects work, discussion, then ask as needed and uploads a non-sensitive photo as an ordinary message; coordinator passes only the current host reference; Codex confirms the image in Phase 1, not from file fallback |
| Phone mode-command matrix | Owner uploads a photo together with each work/discussion/ask command; coordinator supplies `--attach` before consuming the grant; Phase 1 must describe the delivered image |
| Image-only and multiple photos | Owner uploads without caption, then two photos with repeated caption; confirm exact empty/text message and both images, no substituted owner words |
| Unsupported phone format | If available, owner supplies HEIC or an oversized photo; expect a visible all-or-nothing error and no text-only review. Authorized conversion is separate |
| Codex-only and Claude-only | Owner selects each; Codex-only receives a single image-bearing turn; Claude-only does not submit Codex and Fable does not inspect images itself |
| Pending switch and cancellation | Owner interrupts work and selects discussion with a photo; coordinator verifies preserved selection/grant, cancelled old operation and read-only successor; native in-flight writes cannot be rolled back |
| Restart with queue | Owner restarts while a selected image is queued; coordinator uses sanctioned recovery for ambiguous active work, verifies selection retention for queued work and exact canonical resume |
| Exact relay | Coordinator uses `controller relay` unmodified for both phases; Stop accepts complete quotes. No private reasoning or tools are relayed |
| Compaction | At the next owner/host compaction, coordinator verifies the timestamp without reading/transcribing private transcript content |
| Process/RAM and Desktop | Coordinator observes bounded process fields where native permissions allow; owner checks Desktop Recents and RAM across repeated cycles/restarts if not accessible. Stop and investigate any renewed thread/process growth before calling the gate passed |
| Cleanup | Coordinator audits the exact old-copy targets and active-use result. If unique files, missing provenance, lsof restrictions or native refusal appear, preserve and report them—no wildcard/force workaround |

## Limits, not hidden unfinished features

The host may put photos and expanded ARGUMENTS in Fable's context. The prompt hook does not reliably receive phone-image references; Fable must forward the current reference without reviewing the photo. Session-root validation does not prove same-message image provenance. Duplicate receipts are bounded by operation retention; ambiguous SDK outcomes are not automatically replayed. Files must remain stable while queued. Native sandbox restrictions are never overridden by guard allowances. Marketplace approval and broader Beta dogfood gates remain separate.
