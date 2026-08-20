# Changelog

## 1.1.0 - 2026-08-20

- Added `workClaude`, `discussionClaude`, and `discussionCodex`, plus participant selection across the eight supported work, discussion, and ask modes.
- Changed `/ask` and `/discussion` to consult both Claude and Codex. This can add latency and consumes Codex usage compared with 1.0.x; use the Claude- or Codex-specific variants when desired.
- Added canonical mode labels, configurable reply badges, and an opt-in deterministic read-only status-line renderer.
- Migrated persisted state automatically and atomically from schema v1 to v2, adding `participants` and one-shot `returnTo` state without sending existing installs into recovery.
- Made ask-once restore the exact prior persistent route and participants instead of always returning to normal joint work.

## 1.0.1 - 2026-08-20

- Strengthened normal-session operational delegation with an imperative rule for image and screenshot inspection, GitHub and `gh` command sequences, and log-dump analysis.
- Documented which routing protections are mechanically enforced and which collaboration behaviors remain advisory.
- Reworded routing, blindness, delegation, and model-compatibility claims to distinguish deterministic controls from model-dependent behavioral compliance.

## 1.0.0 - 2026-08-19

- Initial public release.
- Added blind independent Claude and Codex views with Codex-led implementation.
- Added normal, discussion, ask-once, and recovery-read-only routing.
- Added transactional state, layered configuration, recovery controls, and public documentation.
- Documented the final single-run implementation benchmark: the two-lane design used 2,224 Claude output tokens versus solo Claude's 3,919 (about 43% fewer), while using more cache-read tokens; Codex-side usage remains separate real spend, and the release gate remains the median of repeated paired runs.
