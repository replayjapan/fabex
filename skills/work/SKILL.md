---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both` from the resolved workstream root and show the mode message. Apply the configured reply badge. Both means every subsequent owner turn is queued once on the canonical verified Codex SDK thread through `/fabex:jointly`; implementation turns use `workspace-write`, and mode changes never replace the ID.

Executor authority remains fixed: Codex performs every project file edit; create `fabex-operational` with the effective `models.operational` value passed explicitly for every GitHub or `gh` sequence; Claude coordinates and verifies. Normal-mode Claude main-session Write/Edit/NotebookEdit is denied. Owner-named recorded executor exceptions are the only bypass.
