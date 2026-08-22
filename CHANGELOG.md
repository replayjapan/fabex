# Changelog

## 1.3.0 - 2026-08-22

### Why we made this change

The top priority is continuity during a working session: Codex should retain the same conversation memory when the owner moves between work, discussion, and ask modes. The companion design used separate threads and app/companion hydration, which created Codex Desktop session clutter and, in the owner's real workflow, contributed to memory growth of roughly 60 GB and a machine crash. Returning to MCP lets Fabex meet the in-session continuity priority with a much simpler design and avoids over-engineering restart behavior that is not the primary goal.

### What it gave us

- One continuous Codex thread across every Codex-including mode, with the exact returned `threadId` verified on every continuation.
- A smaller plugin with no companion discovery, background-job store, sibling-thread coordination, polling, result fetching, re-sync tasks, or checkpoint-and-refresh machinery.
- No new ordinary Codex Desktop session clutter in current observed app behavior, while keeping that behavior explicitly outside Fabex's guarantees.
- No added credential, API-key, billing, or billing-guard surface; Fabex uses the installed Codex CLI's existing authentication.

### Tradeoffs we accepted

- Background execution, status/cancel controls, and the companion job audit trail are gone. A long synchronous Codex turn can now run silently for many minutes with no progress display.
- Restart-durable continuity is no longer a primary guarantee. Reattachment is best-effort, and a definitively unavailable thread can be replaced once from the bounded checkpoint; that seed cannot recreate unrecorded reasoning or the full transcript.
- Discussion and ask modes are behaviorally read-only instructions on the same continuous `workspace-write` thread, not mechanically separate read-only sandboxes.
- The MCP thread's current invisibility in ordinary Codex Desktop recents is app behavior, not a guarantee; Fabex cannot promise future Desktop visibility or resource behavior.

### Changes

- Replaced the Codex companion background-task transport with the installed Codex MCP server and its synchronous `codex` and `codex-reply` tools. Removed companion discovery, job lifecycle, status polling, result fetching, resume-candidate inspection, and re-sync task creation.
- Consolidated the former primary and write siblings into one canonical `workspace-write` Codex thread that remains continuous across every Codex-including Fabex mode change. Mode changes no longer create Codex threads.
- Added mechanical continuation verification using the `threadId` returned in MCP structured content. Calls remain serialized per workstream; missing or mismatched IDs, interruptions, timeouts, and ambiguous outcomes fail closed.
- Changed restart recovery to one lazy, best-effort exact-ID `codex-reply` attempt. A definitively unavailable thread permits at most one bounded-checkpoint-seeded MCP replacement; ambiguous failures never create replacements automatically.
- Migrated schema v1-v3 state atomically to the single-thread schema while retaining bounded owner goals, accepted decisions, current status, and repository fingerprints. Stored companion thread IDs and operations are retired.
- Removed caller-supplied thread completion and all direct companion result-fetch paths. MCP results are accepted only by the PostToolUse hook from the synchronous response carrying the structured thread ID.
- Updated the route guard to validate the exact Codex MCP tools and canonical thread ID, deny MCP use in Claude-only modes, and hard-deny Claude main-session Write/Edit/NotebookEdit in normal mode. The owner-named recorded executor-exception escape, operational-executor authority, and GitHub push protections remain in force.
- Corrected Claude-only capture semantics: raw Claude-only questions and answers are neither relayed to Codex nor placed in its restart seed. Owner-approved decisions and relevant current status may still enter the bounded checkpoint.
- Added bounded pruning of terminal operation records while preserving unresolved recovery records and the continuity checkpoint.
- Kept Sonnet as the configurable operational-agent default and now requires the selected model to be passed explicitly when creating the agent. Fabex does not promise that the configured model is always cheaper.
- Kept credential handling outside Fabex: the plugin does not request, store, inspect, sanitize, or configure credentials.
- Retired the repeated paired benchmark as a release blocker. Existing measurements remain informational; repeated paired runs are required only before publishing new quantitative savings claims.
- Updated installation, privacy, retention, continuity, and marketplace documentation for MCP. Restart continuity is best-effort, MCP visibility in Codex Desktop is not guaranteed, and discussion mode is behaviorally read-only but cannot mechanically remove write capability from the continuous thread.
- Added the stable `Fabex partner — <project> — continuous session` first-line convention.
- Repository implementation is complete, but activation, exact live tool exposure, same-thread mode transitions, interruption handling, and cross-restart behavior remain pending the owner's future plugin reload.

## 1.2.0 - 2026-08-21

- Added persistent primary and write Codex threads, bounded checkpoints, repository fingerprints, per-workstream serialization, mechanical resume-ID verification, and fail-closed mismatch handling.
- Migrated schema v1 and v2 state automatically and atomically to schema v3; existing recorded partner threads become primary threads and are checkpoint-seeded on session re-sync.
- Made every owner message in every both-participant mode consult Codex, including greetings and lookups. Latency and Codex usage increase by design, per owner requirement; single-AI modes remain the only exclusion.
- Replaced the former view-isolation wording with an auditable current-turn opinion-blind protocol while retaining shared owner-visible history and prior converged decisions.
- Added stale-repository warnings, status-visible thread metadata, owner-offered checkpoint-and-refresh guidance, and outermost-owner workstream-root resolution that prevents abandoned nested state from shadowing an ancestor workstream.
- Added the permanent owner-mandated partnership-parity watchdog: every Codex prompt carries the owner's words verbatim and invites scope and parity flags, which Claude must relay unedited.
- Fixed mid-session and interleaved primary/write continuity by creating session re-sync threads through the companion background-task store and inspecting its resumable candidate before every `--resume-last`. An absent or sibling-mismatched candidate now routes to one visible, checkpoint-seeded atomic replacement before any prompt launch; post-launch confirmed-missing recovery remains exact-condition-only, while ambiguous inspection/runtime failures and returned-ID mismatches remain fail-closed.
- Codified executor authority: Codex performs all project file edits, `fabex-operational` performs every GitHub or `gh` sequence, and Claude coordinates without directly performing either class of work. Owner approval never overrides the prescribed executor; exceptions require an explicitly named alternate plus bounded authorization and reconciliation records.
- Added a fail-closed push guard that denies main-session, alternate-agent, and ambiguous-identity `git push`, `git send-pack`, Git LFS push, and `gh` operations while allowing only a verified, plugin-scoped `fabex:fabex-operational` subagent identity; the bare agent type remains denied.
- Required emergency or off-books companion recovery to be recorded as a named executor exception and reconciled into the persisted Fabex checkpoint afterward.
- Recorded the delivery deviation for commit `f11e7c7`: Claude pushed it directly; the contents remain valid and history is not rewritten.

## 1.1.0 - 2026-08-20

- Added `workClaude`, `discussionClaude`, and `discussionCodex`, plus participant selection across the eight supported work, discussion, and ask modes.
- Changed `/ask` and `/discussion` to consult both Claude and Codex. This can add latency and consumes Codex usage compared with 1.0.x; use the Claude- or Codex-specific variants when desired.
- Added canonical mode labels, configurable reply badges, and an opt-in deterministic read-only status-line renderer.
- Migrated persisted state automatically and atomically from schema v1 to v2, adding `participants` and one-shot `returnTo` state without sending existing installs into recovery.
- Made ask-once restore the exact prior persistent route and participants instead of always returning to normal joint work.

## 1.0.1 - 2026-08-20

- Strengthened normal-session operational delegation with an imperative rule for image and screenshot inspection, GitHub and `gh` command sequences, and log-dump analysis.
- Documented which routing protections are mechanically enforced and which collaboration behaviors remain advisory.
- Reworded routing, opinion separation, delegation, and model-compatibility claims to distinguish deterministic controls from model-dependent behavioral compliance.

## 1.0.0 - 2026-08-19

- Initial public release.
- Added separated Claude and Codex views with Codex-led implementation.
- Added normal, discussion, ask-once, and recovery-read-only routing.
- Added transactional state, layered configuration, recovery controls, and public documentation.
- Documented the final single-run implementation benchmark: the two-lane design used 2,224 Claude output tokens versus solo Claude's 3,919 (about 43% fewer), while using more cache-read tokens; Codex-side usage remains separate real spend, and the release gate remains the median of repeated paired runs.
