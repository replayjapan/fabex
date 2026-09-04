---
name: recover
description: Reconcile recovery-read-only state and unresolved Codex partner work without guessing effects.
---

# Recover

Start with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status`. For a recorded unresolved partner operation, offer only:

- `recover inspect --operation-id <uuid>` to inspect it;
- `recover abandon --operation-id <uuid>` to record that Fabex will not retry it.
- `recover replace-missing-thread --operation-id <uuid>` only when that failed operation contains the exact verified SDK missing-session text.

For a lock whose owner PID is confirmed dead, use `recover clear-dead-lock`. Never clear a live or unverifiable lock.

For a validated orphaned transaction, choose explicitly between `recover resolve-transaction --commit` and `recover resolve-transaction --discard`. Commit is allowed only for exactly the next generation, or generation zero when state is missing. Discard is allowed only when the journal's relationship to current state is unambiguous. Invalid or ambiguous journals remain untouched. Never edit state files by hand or infer external effects.

Direct or off-books SDK recovery is not implicit. A confirmed missing persisted thread may be cleared only through the exact recovery command; the next real owner message creates a structured-checkpoint-seeded replacement. Ambiguous failures remain recovery-read-only. Never infer external effects.

Recovery actions clear sticky task labels: abandon and confirmed replacement return task status to `active` when queued work remains, otherwise `null`.
