---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both` from the resolved workstream root and show the mode message. Apply the configured reply badge. Both means every subsequent owner turn is queued once on the canonical verified Codex SDK thread through `/fabex:jointly`; implementation turns use `workspace-write`, and mode changes never replace the ID.

Executor authority remains fixed: Codex performs every project file edit; create `fabex-operational` with the effective `models.operational` value passed explicitly for the full Git delivery lane; Claude coordinates and verifies. Normal-mode Claude project writes, including subagents, Bash, and mutating MCP tools, are denied by allowlists. Only a structured owner-named `executor-exception authorize` record can bypass project edit authority.

Every both-participant submission uses the explicit owner-message/Claude-reply-status envelope described by `/fabex:jointly`. Exact verification command patterns may grant a single argv shape without granting general project writes.
