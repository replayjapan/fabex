# Fabex 1.8.1 acceptance

Automated checks do not establish live activation or resource stability. The 1.8.0 acceptance matrix still applies.

## Automated regressions

All named tests are in `tests/unit/regressions-1.8.1.test.mjs`:

- `1.8.1 relay omits JSON, renders only non-empty flags, and preserves exact-answer checks`
- `1.8.1 composed mode commands receive shape guidance without weakening image denial or grants`
- `1.8.1 model-less same-session SessionStart retains metadata and exposes bounded diagnosis`
- `1.8.1 cross-session starts and invalid model switches use honest unknown labels`
- `1.8.1 PostModelSwitch captures the documented target without changing route or grant`
- `1.8.1 schema 13 migrates losslessly and defers while a runner is active`

Run `pnpm test`, the isolated public-tree privacy test, `git diff --check` against the checkout after sync, and `claude plugin validate .`. Never use live state for regression fixtures.

## Live checks still pending

- After plugin update/reload, owner asks a short question: both complete Codex answers appear without metadata JSON; useful non-empty flags are prose and Stop accepts the full relay.
- After the next owner session restart, inspect diagnose's SessionStart source/model status and label. A same-session model-less event preserves evidence; absent prior evidence stays unknown until a model-bearing SessionStart or PostModelSwitch. Do not invent a label or promise every restart carries a model.
- Interrupt an active operation with an owner mode switch and selected image: no stale work writes after the read-only transition; retained selection reaches the correct new turn.
- Restart with an image still queued: verify durable selection, canonical-thread continuity and no duplicate operation or lost caption.
- Observe process counts and RAM across repeated cycles and restarts; record idle baselines and peaks, not a single snapshot presented as stability proof.

No active-runner schema swap: sync only when no runner uses the target source tree. A separate installed plugin-cache runner may finish on its unchanged cached code; do not update/reload that installation until it exits.
