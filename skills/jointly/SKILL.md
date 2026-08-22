---
name: jointly
description: Use for every owner turn in both-participant work mode; preserve one canonical Codex MCP thread, converge honestly, and route all implementation to Codex.
---

# Jointly

Both means both on every owner turn. Questions authorize answers only. Codex performs every project file edit; Claude coordinates and verifies. Native permissions remain authoritative, and Fabex has behavioral limits described below.

Every Codex prompt must contain the owner's message verbatim and must first invite Codex to flag (a) any scope mismatch and (b) any partnership-parity concern—a rule or change that would make Codex less than a full equal partner. Relay each flag to the owner unedited.

## Executor authority

- Codex performs every project file edit through the canonical MCP thread.
- The bounded `fabex-operational` agent performs every GitHub or `gh` sequence, including delivery preflight, staging, commit, and push. Read effective `models.operational` first and pass that model explicitly when creating the agent.
- Claude coordinates and verifies. In normal Fabex mode, its main-session Write/Edit/NotebookEdit calls are mechanically denied.

Owner approval never changes the prescribed executor. An exception is valid only when the owner explicitly names the alternate executor. Before use, record `Executor exception authorized: executor=<name>; scope=<scope>; reason=<reason>` with `control.mjs thread checkpoint --decision`; afterward record the matching `Executor exception reconciled: executor=<name>; scope=<scope>; outcome=<bounded-result>`.

## Canonical MCP protocol

From the resolved workstream root, run Fabex `config`, `status`, and `diagnose`. If participants are `claude`, switch to `both` before invoking Codex. Never implement while a discussion or ask-once route is active; ask the owner to invoke `/work` or `/workClaude`.

Before every Codex turn, run `control.mjs thread begin`. Calls are serialized per workstream. Use only the returned `toolName` and arguments:

- For `mcp__codex__codex`, prepend the exact returned `plan.seed` to the prompt and supply the returned workspace-write policy arguments unchanged.
- For `mcp__codex__codex-reply`, supply only `prompt` and the exact returned `threadId`. Prepend `plan.seed` when present for best-effort restart reattachment.

Do not invoke any other Codex MCP tool, add MCP arguments, call MCP without a running begin record, or use a caller-supplied completion command. The PostToolUse hook accepts only the synchronous MCP response's structured `threadId`, verifies continuations against the canonical ID, and completes the record. Missing/mismatched IDs, interruptions, timeouts, and ambiguous failures enter recovery-read-only. A definitively unavailable thread may authorize one checkpoint-seeded replacement; never create another automatically.

Mode changes never create a thread. The canonical thread is always `workspace-write`; in discussion and ask modes, read-only is an explicit behavioral instruction and cannot mechanically remove that thread's write capability. State that limit when relevant.

## Route deterministically

- **Implement lane:** Build, fix, change, create, update, or implement requests with explicit criteria, plus mechanical fixes. Do not form a separate Claude implementation plan.
- **Decide lane:** Conversation, questions, architecture, design, judgment, and tradeoffs. Claude and Codex share owner-visible history and accepted decisions, but not one another's unpublished current opinion.

## Implement lane

1. State one short task-and-criteria framing line from the owner's words.
2. Begin the canonical operation and invoke the exact returned MCP tool. The prompt includes the owner's words verbatim, accepted approach, criteria, stale-repository warning, parity watchdog, and a request for only: status; parity-review outcome; files changed; diffstat; tests/criteria with exit codes; unresolved risks; decisions needed.
3. Let PostToolUse verify and record the structured thread ID. Never fetch a result separately.
4. Independently run the owner's verification and collect exit codes and a bounded diffstat.
5. If verification fails, begin another reply on the same canonical thread with the original words, failed criterion, essential evidence, correction request, and parity watchdog; then reverify.

## Decide lane

1. Begin the canonical operation and invoke the exact returned MCP tool with the owner's message verbatim, any returned seed, neutral orientation, stale-repository warning when relevant, parity watchdog, and explicit no-effects instructions.
2. Publish Claude's complete current view before the MCP result returns when the runtime allows that ordering; otherwise state that synchronous MCP limits perfect current-turn opinion blindness.
3. After PostToolUse verifies the ID, present both views, relay flags unedited, identify disagreement, and converge. Record accepted decisions with `thread checkpoint --decision`.
4. If implementation is requested after convergence, enter the Implement lane on the same canonical thread.

Never relay full transcripts. Keep checkpoint decisions and current-status summaries bounded.
