---
name: recover
description: Reconcile recovery-read-only state and unresolved Codex partner work without guessing effects.
---

# Recover

1.7.0 adds a completed-cycle relay escape: only for an owner-requested interruption, `recover abandon --operation-id <uuid>` may waive that cycle's pending full-answer relay and missing reconciliation while retaining the stored answers and thread. Cancel queued/working operations first. This is not permission to abbreviate Codex's words; normally paste each complete `relayBlock` and let Stop acknowledge it.

Start with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status`. For a recorded unresolved partner operation, offer only:

- `recover inspect --operation-id <uuid>` to inspect it;
- `recover abandon --operation-id <uuid>` to record that Fabex will not retry it.
- `recover replace-missing-thread --operation-id <uuid>` only when that failed operation contains the exact verified SDK missing-session text.

For a lock whose owner PID is confirmed dead, use `recover clear-dead-lock`. Never clear a live or unverifiable lock.

`cancel` and `recover abandon` inspect the recorded runner PID for a working operation. If that runner is dead, they first mark the operation failed and enter recovery-read-only; `recover abandon` may then clear the known-dead operation normally. A live or unverifiable runner is never killed, guessed away, or abandoned.

For a validated orphaned transaction, choose explicitly between `recover resolve-transaction --commit` and `recover resolve-transaction --discard`. Commit is allowed only for exactly the next generation, or generation zero when state is missing. Discard is allowed only when the journal's relationship to current state is unambiguous. Invalid or ambiguous journals remain untouched. Never edit state files by hand or infer external effects.

Direct or off-books SDK recovery is not implicit. A confirmed missing persisted thread may be cleared only through the exact recovery command; the next real owner message creates a structured-checkpoint-seeded replacement. Ambiguous failures remain recovery-read-only. Never infer external effects.

Recovery actions clear sticky task labels: abandon and confirmed replacement return task status to `active` when queued work remains, otherwise `null`.
