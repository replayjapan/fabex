# Changelog

## 1.2.0 - 2026-08-21

- Added persistent primary and write Codex threads, bounded checkpoints, repository fingerprints, per-workstream serialization, mechanical resume-ID verification, and fail-closed mismatch handling.
- Migrated schema v1 and v2 state automatically and atomically to schema v3; existing recorded partner threads become primary threads and are checkpoint-seeded on session re-sync.
- Made every owner message in every both-participant mode consult Codex, including greetings and lookups. Latency and Codex usage increase by design, per owner requirement; single-AI modes remain the only exclusion.
- Replaced the former view-isolation wording with an auditable current-turn opinion-blind protocol while retaining shared owner-visible history and prior converged decisions.
- Added stale-repository warnings, status-visible thread metadata, owner-offered checkpoint-and-refresh guidance, and outermost-owner workstream-root resolution that prevents abandoned nested state from shadowing an ancestor workstream.
- Added the permanent owner-mandated partnership-parity watchdog: every Codex prompt carries the owner's words verbatim and invites scope and parity flags, which Claude must relay unedited.
- Fixed mid-session and interleaved primary/write continuity by creating session re-sync threads through the companion background-task store and inspecting its resumable candidate before every `--resume-last`. An absent or sibling-mismatched candidate now routes to one visible, checkpoint-seeded atomic replacement before any prompt launch; post-launch confirmed-missing recovery remains exact-condition-only, while ambiguous inspection/runtime failures and returned-ID mismatches remain fail-closed.
- Codified executor authority: Codex performs all project file edits, `fabex-operational` performs every GitHub or `gh` sequence, and Claude coordinates without directly performing either class of work. Owner approval never overrides the prescribed executor; exceptions require an explicitly named alternate plus bounded authorization and reconciliation records.
- Added a fail-closed push guard that denies main-session, alternate-agent, and ambiguous-identity `git push`, `git send-pack`, Git LFS push, and `gh` operations while allowing the verified `fabex-operational` subagent.
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
