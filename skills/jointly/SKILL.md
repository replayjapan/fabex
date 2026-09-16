---
name: jointly
description: Use for every owner cycle in both-participant modes; preserve Codex's independent first reading, then converge on the canonical SDK thread.
---

# Jointly

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label, at most five sentences leading with outcome and failures; details on request; Action required only for a genuine owner decision or action, never a request to say continue; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

Phone uploads (1.8.0): when the host supplies an upload file reference for the current owner message, forward that exact path in the independent Phase 1 `attachments` array without opening or describing the image. Do not put the host note in `ownerMessage`; preserve the owner's bare text and digest. Do not scan uploads, guess the newest file, or reuse another message's photo. The controller permits only the hook-recorded session's directory under `CLAUDE_CONFIG_DIR/uploads` (default Claude config directory when unset), not sibling sessions. Images are limited to six and 16 MiB each; unsupported formats must be converted through an authorized workflow, never silently omitted. If validation fails, stop visibly and report the error; never retry the same request as text-only. Before running a mode command, forward each current host upload reference as a repeated --attach argument alongside the owner grant; never start Phase 1 first and add the missing image in Phase 2. Host-note forwarding is coordination, not an automatic hook capture or proof of current-message attachment provenance.

Relay attachment status accurately: submit lists each path as `selected` (validated and queued). Controller status/result use the same order's zero-based indexes: `submitted` means SDK submission attempted, `delivered` means an image-bearing SDK turn reported completion, and `failed` means delivery was not confirmed (including cancellation). Old records may report null/unknown. Do not say Codex received or reviewed an image merely because it was queued. Paths are erased at terminal state; index/status metadata remains. Report delivery failures without replacing Codex's complete answer.

Both means both on every owner cycle. Questions authorize answers only. Codex performs every project file edit; Claude coordinates and verifies. Native permissions remain authoritative.

Never relay private reasoning or tool logs; always relay owner-visible replies verbatim. Hidden instructions and scratch content are private too. Relay the owner's message verbatim and owner-visible replies only through the strict controller envelopes below. Codex must finish Phase 1 before it receives Claude/Fable's current response.

## Complete answers and images (1.8.0)

1.7.1 image ownership: Codex is the default image reviewer. Fable must not open or visually review images; use Codex's description. If an additional description is needed, invoke `fabex:fabex-operational` with the exact effective `models.operational` value, never silently with Fable. In discussion/ask one supported image-only prompt is `FABEX IMAGE DESCRIPTION ONLY` followed by a newline and JSON `{"attachments":["/absolute/approved/image.png"]}`. Only image description is authorized; no general operational chores. Other bounded read-only delegation is permitted; every tool call remains route-guarded. `claude-code-guide`, WebFetch, and WebSearch may perform read-only research, not implementation or image review. Recovery remains restricted.

For a mode command, the owner can explicitly select an image with a separate trailing line `attach: /absolute/approved/image.png`. These lines and explicit mode --attach arguments become attachments; ordinary path mentions do not. The full owner text, including those lines, remains verbatim. Invalid selections keep the grant and text unused and produce a visible error; fix the selected file and retry the same mode command. Fable must not inspect the file to forward its path. Host-provided inline images and disguised file content remain platform limitations.

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label, at most five sentences leading with outcome and failures; details on request; Action required only for a genuine owner decision or action, never a request to say continue; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

Both phase JSON envelopes optionally accept `attachments`, an array of at most six absolute png/jpg/jpeg/webp/gif file paths, each at most 16 MiB. Paths must resolve inside the workstream/repository or configured externalWriteRoots. Use only owner-approved images; do not annotate or insert your current opinion in Phase 1 images. Fable forwards approved paths without reviewing their images. Keep files stable until execution. Attachment metadata paths are erased on terminal state, not from verbatim owner text or SDK history. No image bytes enter Fabex state. No attachment means text-only behavior is unchanged.

Both phases require ownerSummary (at most 1200 characters) alongside the complete answer and evidence. Codex authors its own summary; Claude never rewrites it. Stop verifies the latest completed Phase 2 summary and label, or the independent summary when no child exists. Legacy records retain full-answer checks. No silent summary omission.

Scope and parity fields are null when absent; only material flags appear in the relay, never routine none lines.

Use labels from session context or status. Claude session evidence takes precedence over the Claude settings default, which is marked [configured] and verified false. Bracketed context suffixes are stripped. Without evidence show Claude (model unknown):. Neither source verifies the served backend model; status and diagnose report the source.

## Executor authority

- Codex performs project edits through the canonical SDK thread.
- Claude may perform reviewed owner-authorized Git delivery directly in work mode under host permissions. The verified fabex-operational agent is optional; if used, pass effective models.operational explicitly.
- Claude coordinates and verifies. Codex retains source authorship. Routine authorized development effects defer to the host after target/effect review, not a general command allowlist. Generated artifacts, installs and reviewed development DB effects are not automatically source authorship. Never use scripts or MCP to evade the role. Destructive resets, production changes and unrelated privilege remain outside scope.
- Only an owner-typed Fabex mode slash command may change route or participants. Claude, Codex, and subagents must not invoke a mode skill or fabricate a grant.

Owner approval does not change the prescribed executor. An exception is valid only when the owner explicitly names the alternate executor. Record it with `control.mjs executor-exception authorize`; clear it with `executor-exception reconcile`. Decision prose never grants permission.

## Two-phase SDK protocol

From the resolved workstream root, run Fabex `config`, `status`, and `diagnose`. If participants are `claude`, ask the owner to invoke `/fabex:work`; never switch participants autonomously.

Phase 1 is strict JSON with the fields below plus optional `attachments` and UUID `requestId`. Prefer `previousReplyStatus: "recorded"` so the controller inserts the complete session-bound Stop reply, or explicitly reports it unavailable. Do not reproduce a long reply by hand. Keep `requestId` and the entire serialized submission unchanged on a retry; use a new ID for a new owner message. `previousReply` means Claude's previous owner-visible reply, which the owner has already seen—not Claude's current analysis. Use `previousReplyStatus: "none"` only when none exists.

The prompt hook ignores task/system/reminder/local-command notifications. It retains up to eight private owner records with bounded original text (except Claude-only Q&A). Use `control.mjs prompts` to identify the specific digest, then `ownerMessageStatus: "recorded"` and `ownerMessageDigest` instead of retyping. `ownerMessageRef: "latest"` is valid only for one unambiguous candidate newer than the last cycle. Never submit a notification as owner authority. Small supplied-text differences select a unique recorded original, never altered wording. The consumed mode grant's task text is reusable; no universal one-message/one-cycle limit exists. Reuse a requestId only for technical retries of the same submission, not for a new continuation cycle.

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

### 1.9.2 task continuity and RAM precautions

Before each heavy check, build, install, migration or server startup, inspect
`control.mjs heavy status` and `control.mjs mem`. Do not batch heavy jobs in
parallel tool calls or shell backgrounds; use conservative worker counts. When
occupied or critical, run `control.mjs heavy wait --timeout 120`, repeat exit 3,
then retry automatically without asking the owner to send another message. Host
hooks reserve recognized commands atomically; Codex command events are recorded,
not a native pre-execution guard. Other apps, workstreams and child workers still
consume RAM. Unknown memory is a warning, never proof of safety.

1.9.3: both executor wait commands consume the continuation budget. Exit 4 means
stop polling, inspect the active job and report the actual blocker; do not loop
on exit 4 or waive unfinished review/relay. The passive wake watcher remains
bounded. A finished/cancelled turn is not proof its child jobs ended.
Host heavy commands request an owned wrapper without bypassing host permissions.
Inspect wrapper status. Use `heavy release <id>` only with verified process/group
completion; unknown legacy records require an owner-typed `recover heavy <id>`
before running that recovery control. This clears bookkeeping, never processes.
An explicitly owner-approved, named `recover-heavy:<id>` executor exception is
also supported; record the approval faithfully, never infer it from a general
implementation request, and reconcile the exception after recovery.
Never bypass the queue via another executor. A repair's implementation approval
does not authorize clearing an unidentified record. Preserve needed previews.

At checkpoints inspect `resources list`; release unused task-owned resources via
`resources release <id>` or their native host controls, or use
`resources retain <id> --note <reason>` for required previews. Confirm host task
completion. Never kill by port or guessed PID, and never erase an old lease merely
because time passed. Browser/MCP contexts outside tracked host tasks require their
native cleanup; closing a page is not proof the tooling process exited.

Set `checkpoint open-work <item>` only for required, authorized, feasible steps.
Use `checkpoint replace open-work` with a JSON array on stdin to replace it, and
`checkpoint clear open-work` when done. Record genuine `owner-action-required` or
`blocker` reasons and clear resolved ones. New owner prompts reset a 20-step budget
(cycles, Stop nudges and executor waits) and disarm old work; revalidate scope,
never resume from stale TODOs.
Continue on the recorded owner digest through both phases without another message
until done, interrupted, genuinely blocked or budget-exhausted. A timeout is not
completion. Report the exact rejection and remaining work if continuation fails.
No mode changes, approval invention, or prompt reconstruction loops.

1. Submit strict Phase 1 without Claude's current view.
2. Read the stored independent result, compare it with Claude's review, and adjust the plan when evidence warrants it.
3. Submit linked Phase 2 with Claude's current owner-visible response.
4. Relay flags unedited and implement only through Codex.
5. Independently run the owner's verification and collect exit codes and a bounded diffstat.
6. If verification fails, start a new two-phase correction cycle on the same canonical thread.

## Decide lane

Use the same two phases with the route's mechanical read-only sandbox. Present both conclusions, identify disagreement, converge, and record only owner-approved decisions. Mutual blindness is not promised: Claude may read Codex's stored Phase 1 before writing Phase 2; Codex remains independent-first.

Use `checkpoint capacity` before long projects. Compact or export and atomically replace bounded arrays instead of discarding current task context. Keep checkpoint fields under the complete 48 KiB recovery-seed limit.


## 1.8.0 reliability workflow

Use `controller.mjs relay --operation-id <uuid>` to obtain only the exact relayBlock, and paste it unmodified. Ordinary both-participant image-only requests use `ownerMessage: ""` with attachments; mode uploads use repeated `--attach` arguments before grant consumption. Prefer `previousReplyStatus: "recorded"`; unavailable evidence must be reported, not invented or truncated. Healthy discussion/ask allow only validated external scratch/memory writes, never project writes. Image restrictions remain in unhealthy states. Follow `docs/acceptance-1.8.0.md`; automated tests do not establish live phone or resource behavior.
