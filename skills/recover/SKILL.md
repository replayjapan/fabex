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

Emergency or off-books companion recovery is not an implicit recovery path. It is valid only as a named executor exception: the owner must explicitly name the alternate executor and scope. When state is healthy, record `Executor exception authorized: executor=<name>; scope=companion-recovery; reason=<reason>` through `thread checkpoint --decision` before acting, then record `Executor exception reconciled: executor=<name>; scope=companion-recovery; outcome=<bounded-result>` afterward. When state is unavailable, preserve the exact authorization and executor name in the visible transcript, use only the documented controls above to restore healthy state, and immediately add both bounded checkpoint records. Never infer off-books effects during reconciliation.
