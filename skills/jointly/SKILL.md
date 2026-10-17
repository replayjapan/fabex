---
name: jointly
description: Use for every owner cycle in both-participant modes; preserve Codex's independent first reading, then converge on the canonical SDK thread.
---

# Jointly

For current owner messages, UserPromptSubmit queues the exact text and supported
selected attachment references automatically. Use the returned operation ID;
seal your own independent assessment before waiting. Do not resubmit the message.
The strict submit envelopes below remain for reconciliation and legacy uncaptured
messages. Distinct owner messages have distinct IDs even when their text matches.
A retry with the same host message ID reuses its existing delivery. Hosts without
message IDs cannot distinguish hook replay from a second identical message;
report that limitation instead of deduplicating by text.

Phase 1 is read-only, including Test Writing and Documentation. Only reconciliation
may implement the agreed owner-authorized task. Questions authorize answers only;
a partner proposal is never new owner authority. Pending corrections suspend
implementation. Complete the existing review cycle before affected work resumes.
Use `controller.mjs continue --operation-id <completed-reconciliation-id>` for
armed, unfinished agreed work; do not submit the original request as another task.
Keep checkpoint open-work accurate, and reuse unchanged research and passing checks.

If delivery or execution fails, retain the task and report the failed message ID
and reason visibly. Never retry an attachment failure as text-only. Capacity
refusals get at most two retries when nonexecution is established, with the same
model; unknown execution or identity errors retain recovery protections.

Recent context evidence can request a refresh between turns. Both partners check
one shared handoff and save it against the completed reconciliation. The host
controller preserves the predecessor, creates no milestone, and requires the fresh
conversation's handoff digest receipt before permitting implementation. If work
remains armed, continue from the completed reconciliation ID: the first successor
turn only acknowledges the handoff, then continue from that receipt turn's ID.
No new owner prompt is required. A historical
compaction count alone is not a refresh trigger.


Owner-facing reply: show each participant's own short conclusion under its model-aware label, then Decided. Paste Codex's ownerSummary and label unchanged. Omit resolved disagreements and routine uncertainty; show an open issue only when it affects an owner decision, blocks progress or materially limits the result. Action required appears only when the owner must act. Omit empty sections and absent partners. Keep the complete phase records available through result and relay --full. Wait in bounded slices; a timeout does not complete the task.

Phone uploads: when the host supplies an upload file reference for the current owner message, forward that exact path in the independent Phase 1 `attachments` array without opening or describing the image. Do not put the host note in `ownerMessage`; preserve the owner's bare text and digest. Do not scan uploads, guess the newest file, or reuse another message's photo. The controller permits only the hook-recorded session's directory under `CLAUDE_CONFIG_DIR/uploads` (default Claude config directory when unset), not sibling sessions. Images are limited to six and 16 MiB each; unsupported formats must be converted through an authorized workflow, never silently omitted. If validation fails, stop visibly and report the error; never retry the same request as text-only. Before running a mode command, forward each current host upload reference as a repeated --attach argument alongside the owner grant; never start Phase 1 first and add the missing image in Phase 2. Host-note forwarding is coordination, not an automatic hook capture or proof of current-message attachment provenance.

Relay attachment status accurately: submit lists each path as `selected` (validated and queued). Controller status/result use the same order's zero-based indexes: `submitted` means SDK submission attempted, `delivered` means an image-bearing SDK turn reported completion, and `failed` means delivery was not confirmed (including cancellation). Old records may report null/unknown. Do not say Codex received or reviewed an image merely because it was queued. Paths are erased at terminal state; index/status metadata remains. Report delivery failures without replacing Codex's complete answer.

Both means both on every owner cycle. Questions authorize answers only. Coding owns application code (Codex by default); the selected Test Writing agent may edit recognized test files. Documentation writers may edit shared text documents; Test Writing does not grant application-code ownership. An explicitly owner-authorized sub-agent may edit code within its recorded exception. Native permissions remain authoritative.

## Session settings and independent assessments

Legacy role statements below are defaults, not a ban on owner-selected session roles.
`control.mjs settings` shows inherited values and session overrides. Only the owner
can grant changes using `/fabex:settings`; viewing does not require a grant. Select
an existing task assignment with `control.mjs role implementation|testWriting|testRunning|imageReview|docs|gitDelivery`
before its review cycle. This does not expand task authorization. One source author
at a time; the other main partner reviews. Claude image access requires its explicit
imageReview assignment. For an experimental editor, isolate source in a worktree or
branch and use a disposable database for database effects; do not change branches
or discard dirty work merely to satisfy a setting.

Include the exact `ownerSessionId` supplied by session context in submission JSON.
It scopes recorded-message lookup when two windows use identical words. The host
guard requires that ID to match its calling session. Queued cycles bind their own
milestone and roles only when the previous two-phase cycle has finished.

New registered sessions use a seal **before execution**: submit Phase 1, write your
own assessment of the original owner message and shared prior context, then run:

```sh
node "/absolute/plugin/path/scripts/controller.mjs" seal --operation-id <uuid> <<'FABEX_SEAL_7F3A2C91'
Claude's independently authored assessment.
FABEX_SEAL_7F3A2C91
```

Then wait and read Codex's result. The queued turn cannot run before the seal;
the controller automatically supplies it in reconciliation. Do not await Codex
before sealing. Existing pre-upgrade cycles finish using their existing protocol.
No private reasoning is required: seal only the concise owner-facing first opinion.

Milestones keep private transcript references, summaries and their own Codex threads.
Use `/fabex:milestone` for the named stage in the owner's plan. A new chat never creates or renames a milestone. Save a
reviewed handoff before switching. Review the actual branch and dirty files when
resuming; never restore old code automatically. Compact first; repeated compaction
is a review signal, not a forced reset. Rotate only after a reviewed handoff at a
completed cycle and verify the successor; archived predecessors remain recoverable.

Partner model/effort requests and per-role preferences are not proof of service.
Codex independent turns use the main partner; role-assigned Codex execution uses the
role model/effort in reconciliation. Claude main settings remain controlled by the
host; verify `/model` or supported helper selection, and report unsupported effort
instead of claiming it was applied. Do not silently substitute models.

When and only when effective usage tracking is on, Claude records one start,
checkpoint, periodic progress and end receipt for both providers through
`control.mjs usage snapshot --event ...`; Discussion permits the same bounded private snapshot command and cached `usage report`.
Do not retry failed tracking in a loop or stop development for it. Off means no
calls, notices or usage sections. The independent global collector is not changed.

Never relay private reasoning or tool logs; always relay owner-visible replies verbatim. Hidden instructions and scratch content are private too. Relay the owner's message verbatim and owner-visible replies only through the strict controller envelopes below. Codex must finish Phase 1 before it receives Claude/Fable's current response.

## Complete answers and images

Image review: Codex remains the default image reviewer. When the owner selects Claude or Both for Image review, the bound main Claude session may inspect the selected images. With Both, send the same approved images to Codex and have each partner give its own first assessment through the existing review cycle; do not add review rounds. This selection grants no code-editing authority. Otherwise Fable must not open or visually review images; use Codex's description. If an additional description is needed, invoke `fabex:fabex-operational` with the exact effective `models.operational` value, never silently with Fable. In discussion/ask one supported image-only prompt is `FABEX IMAGE DESCRIPTION ONLY` followed by a newline and JSON `{"attachments":["/absolute/approved/image.png"]}`. Only image description is authorized; no general operational chores. Other bounded read-only delegation is permitted; every tool call remains route-guarded. `claude-code-guide`, WebFetch, and WebSearch may perform read-only research, not implementation or image review. Recovery remains restricted.

For a mode command, the owner can explicitly select an image with a separate trailing line `attach: /absolute/approved/image.png`. These lines and explicit mode --attach arguments become attachments; ordinary path mentions do not. The full owner text, including those lines, remains verbatim. Invalid selections keep the grant and text unused and produce a visible error; fix the selected file and retry the same mode command. Forwarding a path does not itself grant permission to inspect it; follow the Image review setting. Host-provided inline images and disguised file content remain platform limitations.


Both phase JSON envelopes optionally accept `attachments`, an array of at most six absolute png/jpg/jpeg/webp/gif file paths, each at most 16 MiB. Paths must resolve inside the workstream/repository or configured externalWriteRoots. Use only owner-approved images; do not annotate or insert your current opinion in Phase 1 images. Unless Image review includes Claude, Fable forwards approved paths without reviewing their images. Keep files stable until execution. Attachment metadata paths are erased on terminal state, not from verbatim owner text or SDK history. No image bytes enter Fabex state. No attachment means text-only behavior is unchanged.

Both phases require ownerSummary (at most 1200 characters) alongside the complete answer and evidence. Codex authors its own summary; Claude never rewrites it. Stop verifies the latest completed Phase 2 summary and label, or the independent summary when no child exists. Legacy records retain full-answer checks. No silent summary omission.

Scope and parity fields are null when absent; only material flags appear in the relay, never routine none lines.

Use labels from session context or status. Claude session evidence takes precedence over the Claude settings default, which is marked [configured] and verified false. Bracketed context suffixes are stripped. Without evidence show Claude (model unknown):. Neither source verifies the served backend model; status and diagnose report the source.

## Executor authority

- Codex uses the canonical SDK thread for its assigned work. Coding owns application code; Test Writing owns recognized test files; documentation writers may share text documents.
- Claude may perform reviewed owner-authorized Git delivery directly in work mode under host permissions. The verified fabex-operational agent is optional; if used, pass effective models.operational explicitly.
- Claude coordinates and verifies. Application source belongs to Coding; recognized tests belong to Test Writing. Routine authorized development effects defer to the host after target/effect review, not a general command allowlist. Generated artifacts, installs and reviewed development DB effects are not automatically source authorship. Never use scripts or MCP to evade the role. Destructive resets, production changes and unrelated privilege remain outside scope.
- Activity changes require an owner-typed Modes command; participant changes require `/fabex:settings participants`. Claude, Codex, and subagents must not invoke activity skills or fabricate grants.

Owner approval does not change the prescribed executor. An exception is valid only when the owner explicitly names the alternate executor. Record it with `control.mjs executor-exception authorize`; clear it with `executor-exception reconcile`. Decision prose never grants permission.

## Documentation with Both (default when no writer preference is saved)

Select `control.mjs role docs` for an authorized documentation task. Both partners
read and update the same handoff or document, including the file already used by
the project. A handoff is the shared record the next conversation uses to continue
work; it is not a pair of strategy assessments.

- Read the existing document before editing. Keep its topic structure, covering
  current state, decisions, completed work, remaining work and next steps as needed.
- Coordinate edits one writer at a time. Claude may edit in the bound main work
  session while no Codex operation is active; Codex edits during its turn. Each
  contributes what it knows, can read the other's updates at any time, and checks
  the complete handoff for accuracy. Preserve useful content and attribute any
  unresolved disagreement; neither silently deletes the other's contribution.
- Update the existing file directly. Do not create a companion document, require
  author headings, or store and assemble private drafts. Create a handoff only
  when the project has none and the task calls for one.
- Keep the normal independent assessment, reconciliation and owner-summary relay
  for the owner's request. Those assessments remain separate from the shared
  document: sealing an assessment never requires sealing a document.
- Include the shared handoff's path in the existing continuity checkpoint and
  milestone handoff, so the next conversation reads the current file. Do not
  duplicate it into another document just for the next chat.

Existing single-writer preferences stay effective. Role assignment covers the
agreed documentation task; it does not authorize unrelated coding or publication.
Coding owns application code, scripts and configuration. Test Writing owns recognized test files, and Test Running independently selects who executes tests.
The documentation exception covers text documents (.md, .markdown, .txt, .rst,
.adoc and ordinary extensionless README/HANDOFF/PLAN files), not executable MDX,
agent instruction files or source files under a docs folder. Use normal Edit/Write
for shared documents; do not bypass the boundary through shell scripts or MCP.
Use ordinary Write/Edit for Claude test edits; shell writers and ambiguous multi-file MCP edits do not gain test-only authority. Codex test-writing turns use read-only tools and a validated testEdits response when Claude owns Coding; the controller applies only recognized test paths after verifying hashes and the current assignment. No helper or renewed owner permission is required. Test Running then handles execution. Mixed application/test files and test runner configuration stay with Coding.
Sub-agents get code-editing authority only through an explicit owner-named exception.
Main partners change authority through Coding settings, not executor exceptions.

Claude's direct edits are checked by the host guard. Codex is read-only when Claude
is the selected coder, except on Codex document-writing turns. Those turns require
workspace-write for direct shared-document edits: their document-only boundary is
instructional, not enforced by the native SDK sandbox. Do not describe it as a
complete technical lock. The controller compares project files before and after
non-coding Codex work turns and relays non-document changes as a warning. Include
that warning for the owner and resolve the changes with the Coding AI before
delivery; do not automatically revert existing work. Detection is not prevention
or proof of which process wrote a file. Arbitrary program effects remain a review obligation.
Native permissions remain authoritative. Claude keeps its host-selected model;
Codex's independent answer uses its main model and its working reconciliation
uses any Codex Documentation model/effort override. There is no shared model
setting that switches both partners.

## Two-phase SDK protocol

From the resolved workstream root, run Fabex `config`, `status`, and `diagnose`. If participants are `claude`, use the owner-controlled `/fabex:settings participants` choice; never switch participants autonomously.

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
{"phase":"reconcile","phase1OperationId":"00000000-0000-4000-8000-000000000000","ownerMessage":"owner words verbatim","fableResponse":"current owner-visible Fable response verbatim","workDisposition":{"status":"remaining","remainingWork":["Validate the authorized change."],"reason":"Validation remains."}}
```

Phase 2 is a separate SDK turn on the same canonical thread. The controller—not the caller—adds the stored Phase 1 answer. It rejects a missing, failed, cancelled, already-used, or owner-message-mismatched parent. Wait for Phase 2, read the result, independently verify implementation work, and then give the owner the converged answer.

The queue enforces an owner-cycle barrier: later Phase 1 operations may queue, but cannot run past a completed Phase 1 until its matching Phase 2 finishes or the owner explicitly cancels/recovers it. Use `recover abandon --operation-id <phase1-id>` to release an intentionally abandoned Phase 2 gap.

The controller verifies the first `thread.started` event and requires its `thread_id` to equal the persisted canonical ID on every resume. Discussion and ask use `read-only`; implementation uses `workspace-write`. Missing or mismatched IDs fail closed. A confirmed missing session can be cleared only through explicit recovery; the next owner cycle creates one bounded-checkpoint-seeded canonical replacement.

The `PostToolUse` wake hook starts at most one watcher per project and wakes Claude at a terminal phase when supported. Each async hook is a process, so `wait` remains the deterministic fallback and task-owned watchers must be tracked and cleaned up when no longer needed.

## Implement lane

### Task continuity and RAM precautions

Before each heavy check, build, install, migration or server startup, inspect
`control.mjs heavy status` and `control.mjs mem`. Do not batch heavy jobs in
parallel tool calls or shell backgrounds; use conservative worker counts. When
occupied or critical, run `control.mjs heavy wait --timeout 120`, repeat exit 3,
then retry automatically without asking the owner to send another message. Host
hooks reserve recognized commands atomically; Codex command events are recorded,
not a native pre-execution guard. Other apps, workstreams and child workers still
consume RAM. Unknown memory is a warning, never proof of safety.

Waits do not consume a cumulative continuation quota. Each wait remains bounded
at 120 seconds; retry exit 3 while progress is feasible. Preserve review/relay and
inspect genuinely stalled work. The passive wake watcher remains bounded. A
finished/cancelled turn is not proof its child jobs ended.
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

Every work-mode task reconciliation envelope and Codex result must carry `workDisposition`:
`status` is `remaining`, `done`, `blocked` or `owner-decision`; `remainingWork` is
at most 16 concise authorized steps; `reason` states completion, remaining work,
the real blocker or the specific owner decision. Both partners supply their own
outcome. For a question-only turn that leaves task scope unchanged, both partners
explicitly use `workDisposition: null`. Preserve existing work and prerequisites;
never use null to cancel, change scope, claim completion or authorize new work.
Omitting the field is missing bookkeeping, not the question-only exemption.
Discussion and ask-only turns do not require a task disposition.
Do not mark done until required validation and delivery are finished.
If the owner cancels, explicitly record done with a cancellation reason and no
remaining steps. A question about progress does not cancel ongoing work.

The controller persists matching outcomes automatically. Missing or conflicting
outcomes preserve the checkpoint and stop execution until reconciled. New owner
messages retain the list but pause execution; reconcile their instructions first.
Never infer completion from an empty list or invent work to populate it.

Use `controller.mjs continue --operation-id <review-id>` to endorse the last Codex
disposition and continue the authorized task. To correct missing or conflicting
bookkeeping, append `--disposition '<JSON disposition>'` with Claude's explicit
outcome; the next partner review must settle it before automatic continuation.
No new owner go-ahead is needed for this repair. Never bypass a real review failure.
Legacy checkpoint commands remain available for explicit maintenance, but are
not a replacement for either partner's disposition.

Use the operation-specific wait command in refusals, in bounded slices, and read
the result when ready. A timeout requires another wait; avoid repeated unchanged
“still waiting” replies. Informational host-permission notices must remain visible,
but they do not establish a failed review or waive actual host restrictions.

Continue on the recorded owner digest through both phases without another message
until done, interrupted or genuinely blocked. A timeout is not
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


## Message and attachment handling

Use `controller.mjs relay --operation-id <uuid>` to obtain only the exact relayBlock, and paste it unmodified. Ordinary both-participant image-only requests use `ownerMessage: ""` with attachments; mode uploads use repeated `--attach` arguments before grant consumption. Prefer `previousReplyStatus: "recorded"`; unavailable evidence must be reported, not invented or truncated. Discussion/Ask writes must stay within the effective activity policy: validated research locations and text plans when permitted, or external scratch/memory roots. Application edits remain denied. Image restrictions remain in unhealthy states. Report attachment delivery from recorded status; do not infer successful forwarding from a valid path alone.
