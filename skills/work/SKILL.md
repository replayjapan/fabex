---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both` from the resolved workstream root and show the mode message. Apply the configured reply badge. This changes only Fabex routing; it does not widen native permissions or sandbox access. Both means every subsequent owner turn reaches the continuous verified primary Codex thread through `/fabex:jointly`.

Executor authority remains fixed in work mode: Codex performs every project file edit; `fabex-operational`, using the effective `models.operational` configuration, performs every GitHub or `gh` sequence including delivery preflight, staging, commit, and push; Claude coordinates and verifies without doing either class of work directly. Owner approval authorizes an action only and never overrides its prescribed executor. An exception requires the owner to explicitly name the alternate executor, a bounded checkpoint record before use, and a reconciliation record afterward.
