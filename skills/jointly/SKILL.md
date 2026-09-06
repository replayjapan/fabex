---
name: jointly
description: Use for every owner cycle in both-participant modes; preserve Codex's independent first reading, then converge on the canonical SDK thread.
---

# Jointly

Both means both on every owner cycle. Questions authorize answers only. Codex performs every project file edit; Claude coordinates and verifies. Native permissions remain authoritative.

Never relay private reasoning or tool logs; always relay owner-visible replies verbatim. Hidden instructions and scratch content are private too. Relay the owner's message verbatim and owner-visible replies only through the strict controller envelopes below. Codex must finish Phase 1 before it receives Claude/Fable's current response.

## Complete answers and images (1.7.0)

For every Codex turn, retrieve `controller.mjs result --operation-id <uuid>` and paste its entire `relayBlock`, including the opening flags and final paragraphs, before your separate view. Both Phase 1 and Phase 2 must be labeled; Phase 2 corrections never silently replace Phase 1. Summaries follow the full quotes, never replace them. Never call an excerpt a complete quote. Stop checks the complete stored answers and labels against `last_assistant_message`; relay even long answers in full. On an owner-requested interruption only, use `recover abandon --operation-id <uuid>` to waive that completed cycle; cancel active operations first. Do not use recovery simply to evade the relay check.

Both phase JSON envelopes optionally accept `attachments`, an array of at most six absolute png/jpg/jpeg/webp/gif file paths, each at most 8 MiB. Paths must resolve inside the workstream/repository or configured externalWriteRoots. Use only owner-approved images; do not annotate or insert your current opinion in Phase 1 images. Current Fable-generated review imagery belongs in Phase 2. The owner or Fable can supply the path; keep it stable until execution. Paths are erased on terminal state, not from SDK history. No image bytes enter Fabex state. No attachment means text-only behavior is unchanged.

Both phases return a structured review when valid: answer, scopeMismatch, parityConcern, evidence, assumptions, uncertainties, recommendation, changedFiles, tests; Phase 2 also has disagreements. The answer is the complete owner-facing text. Relay supplemental fields too. Report a fallback/truncation warning honestly, never infer missing structured fields or expose reasoning. Single-participant output remains free text. Permission profiles remain deferred because they do not combine with the explicit native sandbox; do not configure a nonexistent codexDeniedPaths option.

Fabex developer instructions require Codex to report first (a) any scope mismatch and (b) any partnership-parity concern. Relay each flag to the owner unedited.

Use the session context or status `speakers.labels` to attribute replies: `Claude (Fable):` and `Codex (Astra):` when those model families are known, otherwise `Claude:` and `Codex:`. Never invent a model or add version numbers. Place labels outside the verbatim reply body. Model configuration is not served-model verification. During `migration-deferred`, use bounded controller wait or host Monitor/TaskOutput without bypassing the migration gate.

## Executor authority

- Codex performs project edits through the canonical SDK thread.
- `fabex-operational` performs every GitHub or `gh` sequence, including delivery preflight, staging, commit, and push. Read effective `models.operational` first and pass it explicitly when creating the agent.
- Claude coordinates and verifies. Normal-mode project writes by every Claude executor are allowlist-controlled.
- Only an owner-typed Fabex mode slash command may change route or participants. Claude, Codex, and subagents must not invoke a mode skill or fabricate a grant.

Owner approval does not change the prescribed executor. An exception is valid only when the owner explicitly names the alternate executor. Record it with `control.mjs executor-exception authorize`; clear it with `executor-exception reconcile`. Decision prose never grants permission.

## Two-phase SDK protocol

From the resolved workstream root, run Fabex `config`, `status`, and `diagnose`. If participants are `claude`, ask the owner to invoke `/fabex:work`; never switch participants autonomously.

Phase 1 is strict JSON with exactly these fields plus optional `attachments`. `previousReply` means Claude's previous owner-visible reply, which the owner has already seen—not Claude's current analysis. Use `previousReplyStatus: "none"` only when none exists.

The prompt hook ignores task/system/reminder/local-command notification payloads and retains a private ring of eight recent owner-prompt digests. This permits queued legitimate owner messages without relaying or storing their text. Never submit a notification as `ownerMessage`.

```json
{"phase":"independent","ownerMessage":"owner words verbatim","previousReplyStatus":"provided","previousReply":"previous owner-visible reply verbatim"}
```

Use `controller.mjs submit` with JSON only and no trailing note or framing:

```sh
node "/absolute/plugin/path/scripts/controller.mjs" submit <<'FABEX_PHASE1_7F3A2C91'
{"phase":"independent","ownerMessage":"owner words verbatim","previousReplyStatus":"none"}
FABEX_PHASE1_7F3A2C91
```

Use `controller.mjs status --operation-id <uuid>` for a bounded snapshot or wait with `controller.mjs wait --operation-id <uuid> --timeout <seconds>`, then read the bounded terminal response with `controller.mjs result --operation-id <uuid>`. Do not end the owner turn: the Stop hook blocks while Phase 1 is queued/working and while its Phase 2 is missing. Use `controller.mjs cancel --operation-id <uuid>` when the owner cancels.

After Phase 1 is stored, Claude may read it, produce its current owner-visible response, and submit Phase 2 with the exact Phase 1 operation ID and identical owner message:

```json
{"phase":"reconcile","phase1OperationId":"00000000-0000-4000-8000-000000000000","ownerMessage":"owner words verbatim","fableResponse":"current owner-visible Fable response verbatim"}
```

Phase 2 is a separate SDK turn on the same canonical thread. The controller—not the caller—adds the stored Phase 1 answer. It rejects a missing, failed, cancelled, already-used, or owner-message-mismatched parent. Wait for Phase 2, read the result, independently verify implementation work, and then give the owner the converged answer.

The queue enforces an owner-cycle barrier: later Phase 1 operations may queue, but cannot run past a completed Phase 1 until its matching Phase 2 finishes or the owner explicitly cancels/recovers it. Use `recover abandon --operation-id <phase1-id>` to release an intentionally abandoned Phase 2 gap.

The controller verifies the first `thread.started` event and requires its `thread_id` to equal the persisted canonical ID on every resume. Discussion and ask use `read-only`; implementation uses `workspace-write`. Missing or mismatched IDs fail closed. A confirmed missing session can be cleared only through explicit recovery; the next owner cycle creates one bounded-checkpoint-seeded canonical replacement.

The `PostToolUse` wake hook starts at most one watcher per project and wakes Claude at a terminal phase when supported. Each async hook is a process, so `wait` remains the deterministic fallback and process/RAM accumulation remains a dogfood gate.

## Implement lane

1. Submit strict Phase 1 without Claude's current view.
2. Read the stored independent result, compare it with Claude's review, and adjust the plan when evidence warrants it.
3. Submit linked Phase 2 with Claude's current owner-visible response.
4. Relay flags unedited and implement only through Codex.
5. Independently run the owner's verification and collect exit codes and a bounded diffstat.
6. If verification fails, start a new two-phase correction cycle on the same canonical thread.

## Decide lane

Use the same two phases with the route's mechanical read-only sandbox. Present both conclusions, identify disagreement, converge, and record only owner-approved decisions. Mutual blindness is not promised: Claude may read Codex's stored Phase 1 before writing Phase 2; Codex remains independent-first.

Use `checkpoint capacity` before long projects. Compact or export and atomically replace bounded arrays instead of discarding current task context. Keep checkpoint fields under the complete 48 KiB recovery-seed limit.
