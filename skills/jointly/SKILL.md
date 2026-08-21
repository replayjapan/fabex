---
name: jointly
description: Use for every owner turn in both-participant work mode; keep Claude and Codex current-turn opinion-blind, converge honestly, and route all implementation to Codex's persistent write sibling.
---

# Jointly

Both means both on every owner turn, including greetings and lookups. A question is not an implementation request. Never launch a write-enabled task unless the owner explicitly requests a project change. Codex performs all file edits; this contract covers every project file edit. Native permissions and the Codex sandbox remain authoritative.

Every Codex prompt MUST contain the owner's message verbatim. It MUST also explicitly invite Codex, before acting, to flag (a) any scope mismatch and (b) any partnership-parity concern: a rule or change that would make Codex less than a full equal partner. Relay every such flag to the owner unedited before continuing. This owner-mandated watchdog requirement applies to primary and write tasks, including corrective iterations.

## Executor authority

- Codex performs every project file edit.
- The bounded `fabex-operational` agent performs every GitHub or `gh` command sequence, including delivery preflight, staging, commit, and push, using the effective `models.operational` configuration.
- Claude coordinates and verifies the workflow; Claude does not perform project edits or operational work directly.

Owner approval authorizes the action only. It never overrides the prescribed executor. An executor exception is valid only when the owner explicitly names the alternate executor and the exception is recorded in the bounded Fabex checkpoint before use, then reconciled there afterward. A main-session marker never bypasses the push guard.

For a named exception, record a bounded accepted decision with `control.mjs thread checkpoint --decision 'Executor exception authorized: executor=<name>; scope=<scope>; reason=<reason>'`. Afterward, record `control.mjs thread checkpoint --decision 'Executor exception reconciled: executor=<name>; scope=<scope>; outcome=<bounded-result>'`.

## Handoff and continuity protocol

From the resolved workstream root, run Fabex `config`, `status`, and `diagnose`. If status reports `participants: claude`, switch the current persistent route to `--participants both` before invoking the companion. Never implement while a read-only route is active; ask the owner to invoke `/work` or `/workClaude` first.

Before every companion task, run `control.mjs thread begin primary` for conversation/Decide work or `control.mjs thread begin write` for implementation. The begin control reads the companion's resume candidate before authorizing a resume. Use exactly the returned `plan.companionFlag`: `--resume-last` only when that candidate matches the recorded thread; `--fresh` when the plan reports no thread, a read-only-to-write boundary, a checkpoint-seeded session re-sync, or a visible checkpoint-seeded recovery from an absent/mismatched resume candidate. Include any returned `plan.seed` and primary checkpoint current status in the prompt. Launch with `node <companion>/scripts/codex-companion.mjs task --json --background --cwd <root> <plan-flag> [--write] [--model <model>] --effort <effort> '<prompt>'`. Calls are serialized per workstream.

After the background task finishes, run `control.mjs thread complete <operation-id> --job-id <job-id>`. That control fetches the result, verifies its returned thread ID, and only then exposes the bounded output. Do not fetch through the companion `result` command separately. If completion reports `recovered: true`, visibly tell the owner that the confirmed-missing companion thread was replaced from the persisted checkpoint. A mismatch is fail-closed: pause and ask the owner; never silently open or accept another thread. Repo-dependent prompts must say the repository may have changed and earlier file observations are non-authoritative. If status recommends checkpoint-and-refresh, offer it to the owner; never reset silently.

Emergency or off-books companion recovery is always a named executor exception. If Fabex state is healthy, record authorization before the recovery and reconciliation after it. If state is unavailable, preserve the exact owner authorization and executor name in the visible transcript, restore state only through documented recovery controls, then record both bounded exception entries immediately after state becomes healthy. Never infer effects from off-books work.

## Route deterministically

- **Implement lane (default):** Build, fix, change, implement, create, or update requests with explicit acceptance criteria, plus mechanical fixes. Do not form or state a separate Claude implementation analysis.
- **Decide lane:** Any conversation, question, approach, architecture, design, judgment, or tradeoff. Claude and Codex share owner-visible history and prior converged decisions but not one another's current unpublished opinion.

## Implement lane

1. State one short framing line containing only the task and acceptance criteria from the owner's words. Do not add a proposed fix.
2. Begin the persistent write-thread operation, then launch a write-enabled background companion task with the returned thread flag. The prompt contains the owner's message verbatim, any converged approach, acceptance criteria, stale-repository warning, and the parity-watchdog invitation above. Require only this bounded summary: status; parity-review outcome; files changed; diffstat; tests or criteria checked with exit codes; unresolved risks; decisions needed.
3. Wait with the exact companion `status --json --wait --cwd ... <job-id>` form, then use the Fabex thread-complete control to fetch and mechanically verify before relaying the bounded result. A bounded write outcome is persisted as checkpoint current status so the next primary consult carries it.
4. Independently run the owner's tests or criteria and collect exit codes and a bounded diffstat. For a mechanical fix, also run relevant existing tests. Narrow diff inspection is allowed for security-sensitive changes.
5. If verification fails, resume the same write thread through another begin/complete cycle. The corrective prompt still carries the owner's original words verbatim, the failed criterion, essential evidence, requested correction, and the parity-watchdog invitation. Reverify.

## Decide lane

1. Begin the primary-thread operation and launch a read-only background companion task with the returned thread flag. The prompt contains the owner's message verbatim, any returned checkpoint seed, prior owner-visible decisions, neutral orientation, the stale-repository warning when relevant, and the parity-watchdog invitation. Never include Claude's current opinion or draft.
2. While Codex runs, form Claude's view and publish Claude's complete current view as visible assistant text before any `status` or Fabex thread-complete fetch.
3. Fetch the result, mechanically verify its thread ID, then present both views, relay parity or scope flags unedited, identify material disagreement, and state the converged decision. Record the exact accepted decision with `control.mjs thread checkpoint --decision '<accepted-decision>'`. The transcript order makes current-turn opinion separation auditable.
4. If implementation was requested, enter the Implement lane using the owner's message verbatim, converged approach, and acceptance criteria. The write sibling is separate because the primary thread is read-only.

Never relay full transcripts. Keep checkpoints and outcomes bounded.
