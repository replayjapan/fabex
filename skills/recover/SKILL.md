---
name: recover
description: Reconcile recovery-read-only state and unresolved Codex partner work without guessing effects.
---

# Recover

Start with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status`. For a recorded unresolved partner operation, offer only:

- `recover inspect --operation-id <uuid>` to inspect it;
- `recover retry --operation-id <uuid>` to arm an explicit retry;
- `recover abandon --operation-id <uuid>` to record that Fabex will not retry it.

For a lock whose owner PID is confirmed dead, use `recover clear-dead-lock`. Never clear a live or unverifiable lock.

For a validated orphaned transaction, choose explicitly between `recover resolve-transaction --commit` and `recover resolve-transaction --discard`. Commit is allowed only for exactly the next generation, or generation zero when state is missing. Discard is allowed only when the journal's relationship to current state is unambiguous. Invalid or ambiguous journals remain untouched. Never edit state files by hand or infer external effects.

Emergency or off-books MCP recovery is not implicit. It requires an owner-named executor exception with `scope=mcp-recovery`, recorded before and reconciled afterward. A definitively unavailable persisted thread permits at most one checkpoint-seeded replacement; ambiguous failures remain recovery-read-only. Never infer external effects.
