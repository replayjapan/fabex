---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

This skill is owner-invoked. `UserPromptExpansion` supplies a single-use grant ID. If no grant is present, do not change mode. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both --grant <provided-id>` from the resolved workstream root and show the mode message. Apply the configured reply badge. Both means every owner cycle uses independent Phase 1 followed by linked Phase 2 on the canonical verified Codex SDK thread; implementation phases use `workspace-write`, and mode changes never replace the ID.

Executor authority remains fixed: Codex performs every project file edit; create `fabex-operational` with the effective `models.operational` value passed explicitly for the full Git delivery lane; Claude coordinates and verifies. Normal-mode Claude project writes, including subagents, Bash, and mutating MCP tools, are denied by allowlists. Only a structured owner-named `executor-exception authorize` record can bypass project edit authority.

Every both-participant owner cycle uses the strict independent/reconcile envelopes described by `/fabex:jointly`. Exact verification command patterns may grant a single argv shape without granting general project writes.
