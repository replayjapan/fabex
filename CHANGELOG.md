# Changelog

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
