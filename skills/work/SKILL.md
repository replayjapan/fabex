---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

This skill is owner-invoked. `UserPromptExpansion` captures command arguments byte-for-byte in private grant state and supplies a single-use grant ID; the expanded skill prompt never contains that text. If no grant is present, do not change mode. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both --grant <provided-id>` from the resolved workstream root and show the mode message. The atomic mode command consumes the grant only after success. With no trailing text it changes mode only. With text it prints a Phase 1 operation ID: wait for it, read its result (which returns the retained owner message), then submit Phase 2 normally. If an older Codex operation is active, wait for the named active operation; Fabex then applies the transition and creates the reserved Phase 1 automatically. Apply the configured reply badge. Both means every owner cycle uses independent Phase 1 followed by linked Phase 2 on the canonical verified Codex SDK thread; implementation phases use `workspace-write`, and mode changes never replace the thread ID.

Executor authority remains fixed: Codex performs every project file edit; create `fabex-operational` with the effective `models.operational` value passed explicitly for the full Git delivery lane; Claude coordinates and verifies. Normal-mode Claude project writes, including subagents, Bash, and mutating MCP tools, are denied by allowlists. Only a structured owner-named `executor-exception authorize` record can bypass project edit authority.

Every both-participant owner cycle uses the strict independent/reconcile envelopes described by `/fabex:jointly`. Exact verification command patterns may grant a single argv shape without granting general project writes.
