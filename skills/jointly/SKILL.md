---
name: jointly
description: Use for every owner turn in both-participant work mode; queue one canonical Codex SDK thread, converge honestly, and route implementation to Codex.
---

# Jointly

Both means both on every owner turn. Questions authorize answers only. Codex performs every project file edit; Claude coordinates and verifies. Native permissions remain authoritative.

Every Codex turn contains the owner's message verbatim. Fabex developer instructions require Codex to report first (a) any scope mismatch and (b) any partnership-parity concern—a rule or change that would make Codex less than a full equal partner. Relay each flag to the owner unedited.

## Executor authority

- Codex performs project edits through the canonical SDK thread.
- `fabex-operational` performs every GitHub or `gh` sequence, including delivery preflight, staging, commit, and push. Read effective `models.operational` first and pass it explicitly when creating the agent.
- Claude coordinates and verifies. Normal-mode main-session Write/Edit/NotebookEdit is mechanically denied.

Owner approval does not change the prescribed executor. An exception is valid only when the owner explicitly names the alternate executor. Record it with `control.mjs checkpoint decision 'Executor exception authorized: executor=<name>; scope=<scope>; reason=<reason>'`; record the matching `Executor exception reconciled` decision afterward.

## Canonical SDK protocol

From the resolved workstream root, run Fabex `config`, `status`, and `diagnose`. If participants are `claude`, switch to `both`. Never implement while discussion or ask-once is active; ask the owner to invoke `/work` or `/workClaude`.

Submit short single-line text with `controller.mjs submit --message '<owner message>'`. For multiline text or any message containing shell-significant characters, use the exact guarded quoted-heredoc form below with a fresh delimiter that does not occur in the message. The quoted delimiter prevents shell interpolation; do not escape or rewrite the body.

```sh
node "/absolute/plugin/path/scripts/controller.mjs" submit <<'FABEX_OWNER_7F3A2C91'
<owner message verbatim>
FABEX_OWNER_7F3A2C91
```

The returned UUID is immediate. Do not invoke the internal runner, call the SDK directly, create another thread, or use retired MCP tools.

Poll `controller.mjs status --operation-id <uuid>` and surface concise changed lifecycle states only. Genuine states are queued, working, command, tests, completed, failed, and cancelled; never expose reasoning events or command output. Use `controller.mjs result --operation-id <uuid>` only after a terminal state.

Messages received while Codex is busy must each be submitted once. The durable FIFO queue processes them sequentially on the same canonical thread. v1 has no steering; cancel the active operation explicitly when waiting is wrong.

The controller verifies the first `thread.started` event and requires its `thread_id` to equal the persisted canonical ID on every resume. Discussion and ask use `read-only`; implementation uses `workspace-write`. Missing or mismatched IDs fail closed. A confirmed missing session can be cleared only through explicit recovery; the next real owner turn creates one structured-checkpoint-seeded replacement.

## Route deterministically

- **Implement lane:** build, fix, change, create, update, or implement requests with explicit criteria, plus mechanical fixes.
- **Decide lane:** conversation, questions, architecture, design, judgment, and tradeoffs. Claude and Codex share owner-visible history and accepted decisions, but not private reasoning.

## Implement lane

1. State one short task-and-criteria framing line from the owner's words.
2. Submit the owner message once. Poll genuine progress without flooding the owner.
3. On completion, inspect the bounded result and relay parity flags unedited.
4. Independently run the owner's verification and collect exit codes and a bounded diffstat.
5. If verification fails, submit a correction on the same canonical thread with original criteria and essential evidence, then reverify.

## Decide lane

1. Submit the owner's message once; the current route supplies a mechanical read-only SDK sandbox.
2. Publish Claude's complete current view before Codex's result when practical; do not expose either model's private reasoning.
3. Present both conclusions, relay flags unedited, identify disagreement, and converge. Record accepted decisions with `control.mjs checkpoint decision`.
4. If implementation is requested after convergence, enter the Implement lane on the same thread.

Never relay full transcripts. Keep checkpoint fields bounded under the total 48 KiB recovery-seed limit.
