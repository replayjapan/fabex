---
name: recover
description: Reconcile recovery-read-only state and unresolved Codex partner work without guessing effects.
---

# Recover

Owner-facing reply: each AI chooses its complete intended response, including detail, evidence and disagreement. Relay Codex's answer and flags unedited under its speaker label; do not substitute a summary or impose brevity or omission rules. Deliver every unread answer, including earlier phases. Use controller relay to retrieve it. Missing delivery is recoverable bookkeeping, never a reason to trap a reply or block unrelated authorized work. A stored answer or hook reminder is not proof of visible delivery. Wait in bounded slices for active partner work; a timeout does not complete the task.

A completed-cycle relay escape is available only for an owner-requested interruption, `recover abandon --operation-id <uuid>` may waive that cycle's pending full-answer relay and missing reconciliation while retaining the stored answers and thread. Cancel queued/working operations first. This is not permission to abbreviate Codex's words; normally paste each complete `relayBlock` and let Stop acknowledge it.

Start with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status`. For a recorded unresolved partner operation, offer only:

- `recover inspect --operation-id <uuid>` to inspect it;
- `recover abandon --operation-id <uuid>` to record that Fabex will not retry it.
- `recover replace-missing-thread --operation-id <uuid>` only when the failed operation reports a recognized missing-session or no-rollout error for the current canonical thread. The command rechecks identity and refuses active work; it preserves the checkpoint and archives the old thread within the same milestone.

For a lock whose owner PID is confirmed dead, use `recover clear-dead-lock`. Never clear a live or unverifiable lock.

`cancel` and `recover abandon` inspect the recorded runner PID for a working operation. If that runner is dead, they first mark the operation failed and enter recovery-read-only; `recover abandon` may then clear the known-dead operation normally. A live or unverifiable runner is never killed, guessed away, or abandoned.

For a validated orphaned transaction, choose explicitly between `recover resolve-transaction --commit` and `recover resolve-transaction --discard`. Commit is allowed only for exactly the next generation, or generation zero when state is missing. Discard is allowed only when the journal's relationship to current state is unambiguous. Invalid or ambiguous journals remain untouched. Never edit state files by hand or infer external effects.

Direct or off-books SDK recovery is not implicit. A confirmed missing persisted thread may be cleared only through the exact recovery command; the next real owner message creates a structured-checkpoint-seeded replacement. Ambiguous failures remain recovery-read-only. Never infer external effects.

Recovery actions clear sticky task labels: abandon and confirmed replacement return task status to `active` when queued work remains, otherwise `null`.

A missing Codex conversation is not a reason to create a new plan milestone.
Do not use `/fabex:milestone` as a recovery shortcut. In healthy recovery state,
the owner can open `/fabex:settings`, answer its exact recorded questions, and
apply that one granted settings change. This does not leave recovery mode or
permit code edits or new Codex turns. Corrupt/locked state still needs diagnosis.
