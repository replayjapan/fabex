# Fabex — Beta

## FOR HUMANS

**Two AI partners, one development conversation.** Fabex brings Claude and OpenAI
Codex together inside Claude Code. Each considers your request independently,
then they compare their conclusions before acting. By default Codex writes code;
Claude coordinates, reviews and delivers the work. You can choose different task
roles in settings without changing those defaults for everyone else.

### What is it for?

Fabex is for people building or maintaining software who want a second opinion
without copying messages between two AI chats. It keeps milestone context,
records decisions and handoffs, and lets you discuss an idea before authorizing
changes. You stay in control of modes and settings.

- **Discuss first, work when ready:** read-only discussion and implementation modes.
- **Keep projects organized:** named milestones, separate Codex threads and saved
  chat references. Spaces in chat names are fine; renaming does not change identity.
- **Choose your team:** project defaults and chat-specific model/task preferences.
- **Reduce babysitting:** continuation, recovery tools and RAM-conscious scheduling.
- **See what happened:** short partner summaries, decisions and genuine action items.

Fabex is beta software. It adds coordination, not infallibility: review important
changes, keep backups and expect the host's normal permission checks. VS Code's
Claude Code integration is the primary workflow; host-specific checks are listed
in the [acceptance notes](docs/acceptance-1.10.1.md).

### Install

You need Claude Code **2.1.261+**, Node.js **20+**, and Codex CLI already signed in
with your ChatGPT/Codex subscription. Fabex does not ask for API keys or add a
separate billing service. Both partners consume their respective account usage.

In Claude Code, run:

```text
/plugin marketplace add replayjapan/fabex
/plugin install fabex@fabex
```

Restart your session, then run `/fabex:diagnose`. Claude Code installs the pinned
Node dependency automatically; normal marketplace installation needs no manual
package command. [Contributor setup](#requirements-and-dependency-installation)
is below.

### First conversation

1. Open your project in Claude Code and use `/fabex:discussion` to explore an idea.
2. Use `/fabex:work` when you want changes, then describe the task normally.
3. View `/fabex:settings` for project defaults and this chat's overrides.
4. Optionally use `/fabex:milestone Checkout improvements` to name a milestone.
   Existing projects keep their current history; setup is not mandatory.
5. Use `/fabex:diagnose` if the installation or connection is unclear.

### What's new?

- **1.10.1:** readable guides, safer chat renames, fuller context accounting and
  clearer recovery controls. [Details](CHANGELOG.md#1101--2026-09-27)
- **1.10.0:** milestone threads, session settings and optional usage tracking.
  [Details](CHANGELOG.md#1100--2026-09-27)
- **1.9.x:** routine-development access, shorter reports, continuation and RAM/recovery
  safeguards. [Release history](CHANGELOG.md)

Optional: [AI Usage Tracker](https://github.com/replayjapan/ai-usage-tracker) shows
recorded Claude/Codex allowance and project token usage. Fabex works without it;
installing it does not enable tracking automatically.

By **rePlay, LLC**, under the [MIT License](LICENSE). Private chat records, usage
data and credentials do not belong in this public repository.

---

## FOR AI BROTHREN

The following is the operational reference for AI partners and contributors.
Preserve the human-facing workflow and existing controls when extending it.

### 1.10.1 maintenance notes

Chat-derived names track renames only for unshared milestones with explicit
chat-name provenance. Owner-named, shared, Legacy and ambiguous older milestones
keep their names. Session titles still update independently. Archive directories
use sanitized names plus stable IDs; provider transcripts are never rewritten.
First registration can scan beyond the recent tail, using bounded memory.

The context index scans complete JSONL records incrementally outside the state
lock. Counts cover the whole retained file only when scanning reaches its end;
partial scans are labeled. Appends resume at the last complete record, while file
replacement/truncation invalidates the index. This is a last-call snapshot, not a
live occupancy gauge or a promise of when native compaction will occur.

`partners.codex.helperServers=off` is an owner-selected, per-session/project option.
Default `inherit` preserves existing tools. Off enumerates MCP servers through the
pinned CLI and disables enabled servers declared in the user's `config.toml` for
that run; it never edits global settings. Standard named MCP tables are supported;
inline maps, unusual names and multiline TOML require explicit reader support and
fail visibly instead of guessing. Status reports the scope, override count and
other enabled entries. Host/plugin-provided tools, other config layers and managed
requirements remain host-controlled. This is not a blanket MCP-off switch or a
guarantee of RAM savings; verify actual host behavior.

`checkpoint blocker --clear` and `checkpoint owner-action-required --clear` are
aliases for existing clear commands. Literal `null` in those two fields is treated
as cleared. During schema transition, controller status/result/relay can inspect
a validated in-memory snapshot without persisting migration; the seal still applies.
Wait returns a migration-pending snapshot rather than mutating its budget.

`cleanup --path <copy> --source <source>` audits an adjacent `<source>-next...`
plugin copy against the source, including untracked files. Unique/different files,
symlinks, copied Git metadata or unverifiable active use prevent deletion. The
original Fabex cleanup form remains supported. Never delete private usage data
or force cleanup after a refusal.

## Optional milestone and session setup (1.10.0)

Existing projects require no new setup: their continuous thread becomes the Legacy
milestone, with the same development, RAM, recovery and mode controls. New features
are additive. Schema 17 migrates private state losslessly after an old runner ends.

`/fabex:settings` displays defaults, overrides and each value's source. Owner-typed
arguments such as `roles.implementation.executor=claude scope=session` grant a
single settings change; agents cannot mint it. `scope=project` explicitly saves a
project default in `.fabex/config.json`; `key=inherit scope=session` removes that
override. Flat validated keys live under `settings` in machine/project config.
Session choices persist privately and do not change another chat. Changes wait for
a completed review cycle. No-argument viewing needs no grant.

Settings include two partner models/efforts; implementation, testWriting,
testRunning, imageReview, docs and gitDelivery assignments; new-chat milestone
policy; context review threshold; summaries; and optional usage tracking. Before a
task, `control.mjs role <role>` selects the already-authorized assignment. Codex's
independent review uses its main partner settings; assigned Codex execution uses
role model/effort during reconciliation. Claude-host model controls remain host
controls: configured requests are not observed service. Unsupported choices fail
at the provider or require explicit host selection; no account model catalog or
silent fallback is claimed. Other permissions are unchanged. Image access and
authorship overrides apply only to the bound main chat, never arbitrary subagents.

`/fabex:milestone <name-or-id>` creates/selects a milestone; no arguments lists it.
With `milestones.newChatMeansNewMilestone=true`, a new Claude session gets one
automatically. Default false continues the current milestone. Titles use matching
custom-title records with a streaming first-registration fallback to older records,
then fall back to the session ID. VS Code
title propagation requires live verification. Private state stores original chat
references, summaries, handoffs and Codex thread bindings outside the source tree.
Nothing moves between provider transcripts and returning never rolls code back.
One active review cycle is serialized per workstream; another chat cannot rebind
its thread or settings while it is busy.

Save a reviewed handoff with `control.mjs milestone handoff --review <phase2-id>
"handoff"`. `milestone rotate --review <phase2-id>` archives the old thread and
seeds a linked continuation at a completed cycle. Original thread records remain
private. Verify the successor before proceeding and preserve the predecessor if
startup fails. Summaries cannot replace current repository checks or original
records. The context gauge is a timestamped **last-call snapshot**, with a count
from an incremental rollout scan, with explicit coverage—not live occupancy. Repeated
compactions prompt review, never an automatic restart. Native compaction remains.

### Independently authored first views

For newly registered both-partner cycles, submit Phase 1, seal Claude's independent
owner-facing assessment with `controller.mjs seal --operation-id <id>` on stdin,
then wait/read. Codex cannot execute until the seal exists. Reconciliation adds
the seal automatically; no early answer exists to leak. Legacy queued operations
retain their protocol. Both reviews and verbatim owner summaries remain required.
This enforces order and prompt separation, not adversarial filesystem isolation:
the SDK must not read Claude's current private assessment through other paths.

### Optional AI Usage Tracker

`usageTracker.mode` is off by default, with session `on/off/inherit`; the installed
launcher is selected explicitly through `usageTracker.path`. Off means no tracker
calls or report sections. On uses `control.mjs usage snapshot --event
start|checkpoint|progress|end [--checkpoint id]`; Claude records once for both
providers. `usage report` uses Fabex's bundled read-only database adapter, without
executing the configured add-on in discussion. Its
database stays outside the plugin cache; failures are nonblocking. Installing it
does not enable Fabex integration, and disabling integration never removes a
separately configured global collector. Account allowance, project token usage
and context size are different measures. No exclusive per-session attribution is
claimed when several chats share a project. See [live acceptance](docs/acceptance-1.10.0.md).

## 1.9.2: bounded continuation and RAM precautions

Routine updates lead with outcomes, important failures and the next step. Claude's
summary is at most five sentences (instructional guidance, not a mechanical cap).
Keep detailed logs in the record or a requested Details section. Omit Action
required unless the owner genuinely must decide or act; never ask for a message
merely to restart authorized, feasible work. Both review phases, separately
authored summaries, verbatim relay, owner-only modes and source authorship remain.

### Forward the recorded message, without retyping

`control.mjs prompts` lists bounded previews and digest references. Prefer a
specific digest in the independent submission envelope:

```json
{
  "phase": "independent",
  "ownerMessageStatus": "recorded",
  "ownerMessageDigest": "<64-character digest from prompts>",
  "previousReplyStatus": "recorded",
  "requestId": "<stable UUID for this submission and its technical retries>"
}
```

Alternatively, `ownerMessageRef: "latest"` replaces the digest only when exactly
one candidate is newer than the last cycle. A specific digest supports authorized
continuation of an older recorded task. No candidate or ambiguous selection fails
visibly. Supplied text may match after line-ending/trailing-whitespace normalization
or at most five edits; Fabex substitutes the unique recorded original and reports
that substitution, never forwards changed instructions. Retrying the same requestId
and envelope cannot queue duplicate work; it is not a blanket exactly-once guarantee
for external effects. Notifications are never owner authorization. Consumed mode
grants record their trailing task text, making that path continuable too.

The private prompt ring retains at most eight records and 2 MiB, with text only
up to 192 KiB per prompt; oversized prompts retain digest evidence only and remain subject to
the existing 192 KiB submission limit; no truncated message is forwarded. Entries are atomically written with mode 0600
outside the workstream. Claude-only messages do not retain raw text for forwarding.

### Continue the authorized task, not every old TODO

In work mode set `checkpoint open-work <item>` (append), replace the list with
`checkpoint replace open-work` with a JSON array on stdin, or clear it with
`checkpoint clear open-work`. Only record required, authorized and feasible work.
Set `checkpoint owner-action-required <reason>` or `checkpoint blocker <reason>`
for a genuine stop, and clear those fields when resolved. Each new owner prompt
resets a 20-cycle/Stop-nudge budget and disarms old work: revalidate scope before
setting open-work again. Stop requests continued work while the list is armed and
unblocked, but permits a visible budget-exhaustion report. A checkpoint is not an
authorization grant; no task is resumed merely because a new question arrives.
The host can still interrupt or limit continuation. Schema 16 migrates older
checkpoints losslessly only after the live-runner migration gate permits it.

### Coordinate heavy commands and inspect memory

Recognized package checks, test runners, installs, migrations and owned-server
startup reserve a per-workstream private slot in the Claude PreToolUse hook.
Overlapping recognized host commands are denied with `heavy wait` guidance;
repeat `control.mjs heavy wait --timeout 120` on exit 3 and retry automatically
when ready, without another owner message. This is serialized admission, not a
FIFO process launcher. Since 1.9.3, admission requests a host `updatedInput`
wrapper around the admitted command, preserving cwd, environment and inherited
stdio. It runs Bash in an owned process group; this is not a transparent wrapper
for unexported interactive shell functions or detached daemons. Host permissions
still apply. Identity/group inspection failures retain the record; status shows
pending/unavailable wrapper acknowledgement rather than claiming interception.
Completion hooks remain a fallback for the exact host tool/task. Never batch
heavy commands in parallel, and use conservative worker counts where supported.
The plugin's own test files run serially.

Codex command events record actual SDK commands and their completion. The runner
instructs Codex to inspect `heavy status` and `mem` and wait before heavy work;
this is observed/instructed, **not native pre-execution enforcement**. Unrecognized
wrappers, child workers, other workstreams and unrelated apps are outside this
admission boundary. Host background-task event shapes need live verification.

`heavy release <id>` clears bookkeeping only after the recorded job process is
gone and its group is empty. It sends no signals. Unknown legacy records need
an explicit owner message `recover heavy <exact-id>`; the main/operational
executor then runs that control in work mode. Recovery records the authorization
digest in checkpoint accepted decisions and a bounded private audit. Approval to
implement a repair is not approval to clear an unidentified reservation.
Alternatively, after explicit owner approval the main/operational executor may
record the existing executor exception with scope `recover-heavy:<exact-id>` and
the owner's reason, run recovery, then reconcile that exception. This follows
the existing authorization-record trust model; it does not prove owner intent
from arbitrary prose or require the owner to retype a long identifier.

The SDK uses a launcher for its pinned native binary on supported macOS/Linux
package layouts. It records that CLI's own group, not a parent-tree guess. Normal
command completion clears its reservation. On interruption, only a verified
dead process and empty group clear unfinished entries. Unsupported layouts retain
the original SDK launch path with unknown identity. Detached subprocesses that
leave that group are outside this evidence boundary; do not launch heavy daemons
through foreground commands. Native host acceptance remains required.

Both executor wait commands consume the shared 20-step continuation budget.
Exit 3 means one slice elapsed; exit 4 means stop polling and inspect the blocker.
Never turn exit 4 into another retry loop. Required review/relay is not waived:
read a completed result or use the existing explicit cancellation/recovery path
for genuinely stalled work. The bounded passive wake watcher uses valid
120-second slices and does not spend executor retry budget.

`control.mjs mem` is read-only, using only query probes (`memory_pressure -Q`,
pressure-level sysctl, vm_stat, swapusage and bounded ps fields). Before admission,
a sample no older than ten seconds denies critical pressure and warns at warn or
unknown. Missing probes are explicitly unknown, not a low-memory estimate from
free percentage. Probes run outside private locks with a two-second total deadline;
failure warns as unknown without failing the hook. Before/after samples retain at most 32 entries; status, diagnose
and dev status expose the latest sample, and status/diagnose report runner and
descendant RSS when available. These are precautions, not proven RAM savings or
a guarantee against crashes. Unknown pressure currently warns rather than blocks.

### Account for task-owned resources

`resources list` shows the existing owned server and observed background host
tasks, including recognizable forwarders/browser jobs. `resources retain <id>
--note <reason>` records a needed preview; `resources release <id>` uses the
existing identity-verified server shutdown or directs the executor to the host's
task control. Host-task IDs are never converted into guessed PIDs. Unknown IDs,
reused PIDs and unrelated processes are not killed. Release unused owned resources
or record why they remain at each checkpoint. Snapshot warns about unexplained
resources; nothing is automatically killed at a phase boundary.

Native browser/MCP contexts not represented by a host task are not automatically
discovered or stopped: use their native controls and verify cleanup. Expired
heavy-job leases are reported after six hours but are not silently erased while
their process might still be alive; confirm completion through the host first.
See [1.9.2 acceptance](docs/acceptance-1.9.2.md) for automated evidence and the
remaining real-host scheduling, resource and memory checks.
See [1.9.3 recovery acceptance](docs/acceptance-1.9.3.md) before claiming the repair
is live. Private locks publish immutable PID/start identity and reclaim only a
verified dead owner. Generation-specific recovery claims protect replacement
locks and remain as small private audit files; unknown legacy lock owners are
not evicted. Heavy status/diagnose expose a saved lock-recovery warning.

### 1.9.0: routine development without command-by-command setup

Within owner-authorized work, review actual targets and effects, then perform necessary dependency installs, generated lockfile updates, reviewed development migrations, scoped fixtures, diagnostics, local HTTP checks and server management. No handwritten command exceptions or repeated owner approvals are required for those routine steps. Do not send the owner to a terminal to compensate for Fabex restrictions.

Codex authors project source; Claude coordinates and may perform reviewed operational work through an authorized host executor. Generated development artifacts and database effects are not automatically source authorship. Since 1.9.1, Claude may deliver reviewed authorized Git changes directly under host permissions or use the optional operational agent. Never use scripts or MCP to evade these roles. Destructive resets, production changes and unrelated privileged access remain outside scope.

The 1.5.0 normal Bash/MCP allowlists and exception-driven repairs exceeded the requested workflow. 1.9.0 removes that general work gate, retaining targeted source-writing, destructive-effect, privilege, deployment and unverified-process-termination checks. A deny list is mechanically looser: it cannot prove arbitrary program effects or identify every production target. Executor review is mandatory, not a new per-command approval ritual. Host permissions remain authoritative.

The optional control.mjs dev start/status/logs/restart/stop helper remains available without configuration. It discovers a single nested app and preserves process identity, stale-PID and port-conflict checks. Existing devServer configuration remains an optional override. Custom script inspection reports review notes instead of blanket migration/seed refusals; destructive markers still fail. Report the command, cwd and intended port; never silently accept a fallback port. Stop only a verified host-owned task or the owned-server helper, never a generic PID or a port occupant. No server starts automatically when a project opens.

Discussion and ask permit read-only searches, transformations, bounded loopback GET/HEAD probes, status/logs and delegated research under the same route guard. Mutations stay denied. Legacy command exceptions are not automatically read-only. Arbitrary database diagnostic scripts without independently read-only execution remain unresolved, rather than silently receiving mutation authority.

Image filenames in Bash/MCP no longer trigger blanket rejection: metadata and capture need not perform visual review. Direct image Read/WebFetch remains denied to Fable. Use Codex or the configured lower-model helper for visual review; host-injected image context remains a platform limitation.

Schema 14 and the network-off default are unchanged. Diagnose identifies the network default's agent-proposed provenance and unresolved disposition. See [restriction provenance](docs/provenance-1.9.0.md) and [live acceptance](docs/acceptance-1.9.0.md). Real database/install/fixture/server/browser/turn-boundary verification is pending; classifier and mock-process passes alone do not prove restoration.

### 1.8.1: readable relay and explainable speaker labels

Owner-visible relay keeps the complete Codex answer verbatim under its speaker and phase label, followed only by non-empty scope mismatch, parity concern, disagreement and uncertainty flags in labeled prose. Routine JSON metadata is no longer displayed. Evidence, assumptions, recommendations, changed files and tests remain available internally through `controller result`. `controller relay` prints the ready-to-paste block; Stop still checks the complete answer and label, not supplemental fields.

Run each mode command standalone from the workstream directory: no `cd` prefix, `&&` chain, trailing command or pipe. A composed mode command is still denied, now with command-shape guidance rather than an image-inspection accusation. Actual image reads remain restricted.

The model-label diagnosis found that a model-less SessionStart erased earlier evidence. The [hooks reference](https://code.claude.com/docs/en/hooks#sessionstart-input) documents `model` as optional. Fabex now retains valid same-session evidence, clears it for a different or unidentified session, and captures `to_model` from [PostModelSwitch](https://code.claude.com/docs/en/hooks#postmodelswitch), supported in Claude Code 2.1.251 and later. That event also covers model restoration on resume. It records session configuration, not proof of the model serving every response; subagent models are not used to name the main session.

Schema 14 adds one bounded SessionStart diagnostic (session ID, enumerated source, model-field status and timestamp), with lossless schema-13 migration and the existing live-runner migration gate. `control.mjs diagnose` exposes `claude.model`, `claude.lastSessionStart` and an explanation. If no valid model has been captured, the label stays honestly `Claude:`. Previously erased metadata cannot be reconstructed; the next model-bearing hook must restore it. No transcripts, image bytes, private reasoning or tool results are collected for this diagnostic. Live checks are tracked in [1.8.1 acceptance](docs/acceptance-1.8.1.md).

> **Beta:** Fabex 1.9.0 is being dogfooded. Do not treat it as marketplace-ready until the live two-phase continuity, hook activation, Codex Desktop visibility, process, and RAM criteria below pass.

Fabex keeps Claude/Fable as the owner-facing interface while Claude and Codex collaborate as equal partners. Every both-participant owner cycle uses two turns on one continuous Codex thread: Codex first records an independent reading, then reviews Fable's owner-visible response. Codex remains the implementation agent, and Claude or an optional operational agent handles GitHub delivery chores. Private reasoning and tool logs are never relayed.

## What 1.8.0 changes

Fabex uses the official TypeScript `@openai/codex-sdk`, pinned with its CLI runtime to 0.153.4. Release 1.8.0 consolidates image forwarding for mode commands, image-only requests and Codex-only turns; bounded lock retries; safer ask return and unhealthy image guards; recorded previous replies and exact relay output; healthy external scratch writes and narrow diagnostics; and verified working-copy cleanup. Codex-default image review, owner-only grants, canonical continuity, independent-first sequencing and Git-delivery authority remain unchanged. See the [acceptance matrix](docs/acceptance-1.8.0.md) for automated evidence versus outstanding live checks.

Fabex leaves the Codex model unset by default so Codex inherits the owner's configuration; an explicit `models.codex.model` overrides it. `diagnose` reports the model source as `Fabex config`, `Codex config default`, or `unknown`. The configuration reading is not verification of the model that served a turn; profile-based or unavailable resolution is unknown. With no configured model, the bundled CLI default can change on upgrade (0.153.4 changes it to Astra). Fabex does not alter the owner's model setting. See the [official Codex changelog](https://learn.chatgpt.com/docs/changelog).

Use labels from session context or status. Claude session evidence takes precedence over the Claude settings default, which is marked [configured] and verified false. Bracketed context suffixes are stripped. Without evidence show Claude (model unknown):. Neither source verifies the served backend model; status and diagnose report the source.

```text
Codex (Astra): Phase 1 — independent
<stored independent answer verbatim>

Codex (Astra): Phase 2 — reconciliation/corrections
<stored reconciliation answer verbatim, including any corrections>

Claude (Fable):
<owner-visible response verbatim>
```

There is no MCP compatibility lane. The old `.mcp.json`, MCP adapter, result hook, structured-content recorder, and begin-authorized tool protocol were removed.

## Modes

| Command | Route | Participants | Codex SDK turn | Mechanical SDK sandbox |
| --- | --- | --- | --- | --- |
| `/work` | normal | Claude + Codex | Every owner message | `workspace-write` |
| `/workClaude` | normal | Claude | Implementation requires owner `/work` | none until joint work |
| `/discussion` | discussion | Claude + Codex | Every owner message | `read-only` |
| `/discussionClaude` | discussion | Claude | none | none |
| `/discussionCodex` | discussion | Codex relay | Every owner message | `read-only` |
| `/ask` | ask-once | Claude + Codex | One owner question | `read-only` |
| `/askClaude` | ask-once | Claude | none | none |
| `/askCodex` | ask-once | Codex relay | One owner question | `read-only` |

Questions authorize answers only. Codex performs project edits. Claude coordinates and verifies. Direct source authorship remains Codex’s role. File-tool and recognized shell/MCP source writes are guarded; general work execution uses targeted checks plus mandatory target/effect review, not an allowlist. Main-session or optional verified operational-agent delivery is available in work mode under host permissions; other subagents and read-only routes remain denied.

Mode commands are owner-only. Typing a Fabex mode slash command fires `UserPromptExpansion`, which issues a grant bound to that session, project, route, and participant set. Optional same-line or multiline text is captured byte-for-byte in private grant state; it is not interpolated into Fable's expanded prompt. The atomic mode command validates the grant, applies the route, consumes the grant, and only then exposes or submits the owner text. Both-participant text becomes a fresh independent Phase 1; Codex-only text becomes one read-only relay turn; Claude-only text is printed to Fable only after the transition. No text means no empty operation. AI-issued mode skills, missing grants, mismatches, and replays fail closed.

An owner mode command supersedes a completed Phase 1 that is still awaiting reconciliation: Fabex retains and marks that reading interrupted, so Stop no longer blocks on it. If a Codex operation is active, the transition and its text remain durable, grant expiry pauses, and the transition applies only after that operation stops. Old queued work is cancelled. A switch to discussion cannot later release workspace-write work from the interrupted cycle.

### Host ARGUMENTS limitation

Claude Code was observed appending an `ARGUMENTS` section itself in 1.6.1, exposing owner text to Fable before Phase 1. The 1.6.2 expansion hook preserves the exact text in grant state and returns an `updatedInput` candidate without that suffix, or the trusted packaged skill body when only the original command is available. Current documentation is inconsistent with the reported rewrite capability: the [UserPromptExpansion reference](https://code.claude.com/docs/en/hooks#userpromptexpansion-decision-control) describes blocking and additional context, not a guaranteed rewrite. Live dogfood reported that the host ignored this candidate and still delivered ARGUMENTS. Early Fable visibility is therefore a known platform limitation; Codex still receives only the private independent Phase 1 input. Do not claim early Fable blindness based on the unit test alone.

## Mechanically enforced and platform-limited behavior

### Images and structured reviews

#### Phone uploads through Remote Control

When the host supplies a saved-photo reference, Fable forwards that exact current-message path in Phase 1 `attachments` without opening or describing it. The bare owner message stays verbatim; the host note is not appended to it. No computer path entry should be needed for an ordinary phone-upload message whose host reference is available. Fabex does not scan directories or guess the newest image.

The dedicated read allowance is `<Claude config directory>/uploads/<hook-recorded session id>/` only. It honors `CLAUDE_CONFIG_DIR` and otherwise uses the default `.claude` directory. Missing or ambiguous matching prompt evidence, sibling-session uploads, files directly under uploads, and resolved symlink escapes are denied even if a broad scratch root covers them. This does not add the uploads folder to `guard.externalWriteRoots` or grant any write permission. Phase 2 uses its stored Phase 1 session binding. Validation repeats before SDK execution.

The live host supplied the file reference outside the prompt-hook text. Forwarding therefore depends on Fable conveying that reference, not a hook scraping images or a transcript. The controller proves the session boundary, not whether a same-session file belongs to this particular message; Fable must never reuse unrelated uploads or omit a rejected photo and retry text-only. For a mode command, Fable must add repeated `--attach <absolute-path>` arguments **before** applying the grant. The images are validated, retained with a waiting grant, and included when the transition creates Phase 1. The owner does not type computer paths. If the host reference is unavailable, report that explicitly rather than start an uninformed review. Repeat a real phone-upload test after reload before claiming seamless forwarding works. Host-injected images may still enter Fable's context despite its tool restrictions.

Image-only requests use `ownerMessage: ""` with at least one image; the empty prompt digest is recorded without inventing owner words. A mode command with neither text nor images creates no turn. Codex-only submissions support `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}` as well as existing plain text. Claude-only modes still exclude Codex; explicit Codex attachments on a Claude-only mode command fail visibly. Phase 2 may keep the empty owner message and is validated against its stored Phase 1 digest.

Selecting both-participant or Codex-only ask without a question waits for the first submitted question, including an ordinary phone photo, before the next owner prompt triggers auto-return. Notification payloads do not consume it. Mode commands with no text and no images still create no empty Phase 1.

Every JSON submission may carry a unique UUID `requestId`. Keep it unchanged when retrying the exact same serialized submission; while its operation record is retained, retries return that operation rather than queue another, even after cancellation. Different input with the same ID is denied. Use a new ID for a new owner message, including repeated captions. This is bounded record-level idempotency, not an indefinite receipt archive; old records are pruned. Without a request ID, identical submissions are separate owner messages.

Submit reports each supplied path as `selected` after validation and queueing. Validation errors exit nonzero, return `operationId: null` with per-path selection/failure information when available, and queue nothing. Status/result retain only zero-based image indexes in `attachments`: `selected` (queued), `submitted` (SDK submission attempted), `delivered` (that image-bearing turn emitted SDK completion), or `failed` (delivery not confirmed, including cancellation). An attempted submission is not receipt; completion is not proof of an accurate image description. Historical metadata can be null/unknown. Terminal attachment paths are erased; indexed delivery metadata remains. Photo files themselves are not deleted by Fabex.

Both strict JSON phase envelopes accept an optional `attachments` array, for example `"attachments": ["/absolute/workspace/app/review.png"]`. The owner or Fable may supply approved image paths; Phase 1 must not include current Fable annotations or opinions disguised as screenshots. Fable forwards approved paths without reviewing the images itself. Current Fable text belongs only in Phase 2. This semantic boundary remains instructional: path validation cannot prove who authored an image.

**Codex is the default image reviewer.** Fable uses Codex's description, not its own image inspection. The guard denies main-session and non-operational subagent Read and WebFetch image access by extension; Bash/MCP filename metadata and capture are not visual review. Recognized extensions include (PNG, JPG/JPEG, WebP, GIF, BMP, TIF/TIFF, SVG, HEIC/HEIF, AVIF, ICO). Validated controller attachment envelopes remain allowed. This is an extension-based routing boundary, not content inspection: disguised or extensionless files cannot reliably be recognized, and the host may still place an image directly in Fable's context.

If an additional description is needed, Fable may explicitly spawn `fabex:fabex-operational` using the effective `models.operational` value, including in discussion and ask. In those read-only routes one supported image-only prompt is `FABEX IMAGE DESCRIPTION ONLY`, a newline, then a JSON object containing only `attachments` (one to six validated image paths). Other bounded read-only delegation is allowed; no mode change or mutation is implied. The helper reads only the selected images and returns a description; it performs no Git delivery, project writes, or shell chores. The model option selects the configured helper, not a guaranteed lower cost or verified served model.

To attach an image from an owner-typed mode command, put a line `attach: /absolute/workspace/app/review.png` in its trailing message. Use the literal lowercase `attach:` at the start of the line and an unquoted absolute path (spaces are supported). Fabex keeps the entire message byte-for-byte, validates the selected images before applying the grant, and sends them with independent Phase 1. Merely mentioning a path does not attach it. Missing or invalid selected files produce a visible error without consuming the grant or discarding the text; if a paused transition's image disappears, restore it and retry the same mode command. Claude-only modes retain their existing no-Codex routing.

Discussion and ask also permit read-only WebSearch, HTTP(S) WebFetch without embedded credentials, and the `claude-code-guide` research agent. These exceptions do not change the mode, permit project writes, or authorize Git delivery; other read-only delegation is permitted with route checks on each tool. Recovery remains fail-closed. Fable pastes the controller's `relayBlock` unmodified rather than retyping Codex's words.

At most six PNG, JPG/JPEG, WebP, or GIF files are allowed, each nonempty and at most 16 MiB. HEIC is not accepted directly; use an authorized conversion workflow rather than silently dropping the image. Paths must be absolute and resolve inside the workstream (including its configured repository), an effective `guard.externalWriteRoots` directory, or the dedicated session-scoped uploads directory above. Symlink escapes are rejected. Files are checked at submission and immediately before execution; supplied files should remain unchanged while queued. The SDK receives `local_image` inputs alongside the phase text, including in read-only discussion and ask. Fabex stores paths only until completion, failure, or cancellation; it never stores image bytes in state. SDK/model processing and persisted Codex history have separate retention; removing Fabex paths does not erase those copies. Share only images approved for sending to Codex.

Every both-participant phase requests `outputSchema` fields: `scopeMismatch`, `parityConcern`, `answer`, `evidence`, `assumptions`, `uncertainties`, `recommendation`, `changedFiles`, and `tests` (`command`, `exitCode`; null means not known). Reconciliation also requires `disagreements`. `answer` is Codex's complete owner-facing answer, including flags, not a summary derived by Fable. The controller retains the validated object in `result.structured` and the exact answer in `result.finalResponse`. Invalid JSON or schema output falls back to the raw response with `structured: null` and an explicit warning; it does not itself fail the operation. Codex-only turns retain free text.

Answers have the existing 32 KiB storage bound. Structured objects have a 48 KiB total bound, 16 entries per array, and 2048 bytes per supplemental string. Overflow falls back visibly, and truncation is explicitly labeled rather than called a complete quote. Token usage is not a context-capacity or billing meter.

### Concise owner-facing relay (1.9.1)

The default order is the mode badge, Claude's own summary with its model label,
Codex's own summary relayed unchanged, Decided, Action required, and TODO tagged
Claude or Codex. Empty sections and absent partners are omitted. Claude never
rewrites Codex's summary. No personal name is embedded in labels or templates.

`ownerSummary` is required in both phase schemas and bounded to 1200 characters.
Schema 15 identifies this review shape. Schema 14 migrates losslessly using the
existing live-runner gate; old complete answers and pending operations stay intact.
An older or missing summary prints a visible fallback and the full answer.
The completed Phase 2 summary satisfies its linked new-format independent
reading's display obligation, not unrelated cycles or legacy records. Full
answers remain available with `relay --full` and `result` while retained in the
bounded history; there is no permanent transcript archive. Material risks and
disagreements remain visible without automatically dumping the transcript.

Waits accept 1–120 seconds per invocation. Repeat on exit 3 (still working),
prefer shorter slices, and never interpret timeout as completion or failure.
This does not establish why any host classifier denied a previous wait.

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

For an owner-requested interruption, `control.mjs recover abandon --operation-id <uuid>` waives the completed cycle's relay and any missing Phase 2 while preserving its stored answers and canonical thread. Cancel working/queued operations before abandonment. This escape is instructional owner authority, not a new cryptographic grant. Never use it merely to shorten an answer. If the host omits `last_assistant_message`, Stop cannot verify delivery; relay explicitly or use the owner-requested escape, rather than claiming verification.

### Permission-profile compatibility

Permission profiles and the legacy sandbox settings **do not combine**. The [official permissions reference](https://learn.chatgpt.com/docs/permissions) says an explicit `--sandbox` selects the legacy policy rather than layering a profile's deny rules onto it. The installed 0.153.4 SDK passes `sandboxMode` as `--sandbox`; accepting TOML configuration is not proof that denial is enforced. Profiles are also Beta and can grant broader access, not just narrow it. Therefore 1.7.0 keeps the existing sandbox unchanged and deliberately does not expose `guard.codexDeniedPaths`. A future migration requires native enforcement tests across platforms and same-thread resume, not a config-only claim of secret-file protection.

| Mechanically enforced | Instructional or platform-limited |
| --- | --- |
| Exact controller submit/status/result/cancel/wait command shapes | Equal model judgment and memory quality |
| A durable FIFO per-workstream owner-cycle queue, one active turn, and Phase 2 barrier | Claude's independent blindness after Codex Phase 1 |
| Strict Phase 1/Phase 2 JSON, stored parent linkage, and owner-message digest | Model judgment quality after context is correctly separated |
| Owner-typed single-use mode grants plus command-level consumption | Protection against a malicious process that can read private Fabex state |
| Exact `thread.started` ID verification on every turn | SDK/CLI service availability and subscription limits |
| Per-turn `read-only` or `workspace-write` SDK sandbox | Codex Desktop Recents visibility across future app versions |
| Claude-only denial of SDK submit | Host model resolution for `fabex-operational` |
| Direct file-tool authorship checks (shell/MCP checks are partial) | Complete continuity after an explicitly replaced missing session |
| Git delivery limited to work-mode main session or verified operational agent | Compliance with reviewed owner-authorized delivery |
| Atomic schema migration and hard 48 KiB complete recovery seed | Resource use of SDK/CLI processes under live workloads |

## Independent-first controller and progress visibility

### Healthy scratch work and verified cleanup

Discussion and ask permit Write/Edit/NotebookEdit and supported single-target Bash writes only to validated memory/scratchpad or configured `guard.externalWriteRoots` locations outside the workstream. Existing ancestors and symlinks are resolved before approval. Unhealthy/recovery state does not gain write access. Native permissions still apply. Image inspection remains Codex's job even during lock contention, corruption or deferred migration.

Exact read probes include `git tag --list`, `git tag -l "v*"`, `du -sh .`, and `ps -axo pid,ppid,rss,etime,comm | grep codex`. Process arguments/environment dumps are not included. Read-only routes do not gain build/test execution or Git delivery; tag creation/deletion and commits require authorized work-mode delivery.

`control.mjs cleanup --path <absolute-directory>` is available to the main or operational executor in healthy work mode. It accepts only `fabex-next` or `fabex-next-<version>` directly under the workstream or system temp roots. It checks the Fabex package/manifest, compares source files against the live checkout or matching delivered tag, rejects unique files/refs and symlinks, and requires `lsof` to prove no active use. If any check or native permission fails, nothing is removed. No wildcards or force fallback. Verified disposable copies are deleted, not moved to Trash; their source files remain recoverable from the verified checkout/tag. Owner photos, caches and local settings are not cleanup targets.

For `participants=both`, Phase 1 accepts strict JSON only. It contains the owner message and, when one exists, Fable's previous owner-visible reply—the reply the owner already saw. It cannot contain Fable's current commentary, extra keys, or trailing text:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" submit <<'FABEX_PHASE1_7F3A2C91'
{"phase":"independent","ownerMessage":"owner words verbatim","previousReplyStatus":"none"}
FABEX_PHASE1_7F3A2C91
```

The controller stores Codex's Phase 1 answer as the independent reading. Only then may Fable submit its current owner-visible response in a separate Phase 2 operation, linked to the exact Phase 1 UUID:

```json
{"phase":"reconcile","phase1OperationId":"00000000-0000-4000-8000-000000000000","ownerMessage":"owner words verbatim","fableResponse":"current owner-visible Fable response verbatim"}
```

The controller retrieves the stored independent answer itself; callers cannot substitute it. It verifies the same owner-message digest and rejects missing, failed, cancelled, mismatched, or already-used parents. Later owner cycles may queue, but a completed Phase 1 creates a barrier until its Phase 2 completes or is explicitly abandoned. This preserves owner-cycle FIFO ordering.

`UserPromptSubmit` records a digest, byte count, time, and session for owner prompts, including empty image captions. Notification-shaped inputs containing task, system, reminder, or local-command markers are ignored, including by ask-mode auto-return. A missing ask return destination fails closed to discussion/both and requires an owner mode command. Since 1.9.2 the bounded private prompt sidecar also retains eligible original text for reference-based forwarding, except Claude-only messages. Ambiguous session evidence is denied rather than guessed.

Stop records the final owner-visible Fable reply and its digest. Schema 13 retains **one complete reply of at most 32 KiB**, session-bound and replaced by the next accepted Stop; it never reads transcripts, reasoning or tool logs. Oversized, absent, interrupted or Claude-only replies remain unavailable, never truncated and called complete. `previousReplyStatus: "recorded"` lets the controller insert the matching stored reply; `provided` with exact `previousReply` remains supported. Recorded text stays out of the 48 KiB recovery seed and status output. Missing evidence produces an explicit unavailable phase header and `claudeReplyVerified: "unavailable"`. Private state and pending operations are local retention; clearing state removes them, not the separate SDK history.

Use `controller.mjs relay --operation-id <uuid>` to print only the ready-to-paste block. Paste the completed Phase 2 summary unchanged; legacy records retain full-answer checks.

Controller writes now wait for locks with bounded backoff (50 ms doubling to 400 ms, about 3 seconds); submission retries generation conflicts by rereading and revalidating. Locks are never stolen. Queued selections and paused grants survive state reload. Cancellation removes terminal operation paths; it does not delete the owner's images or automatically retry ambiguous SDK work.

Owner messages are limited to 192 KiB so an initial turn plus the maximum 48 KiB recovery seed remains below the former 256 KiB failure boundary.

Each phase returns a UUID immediately. While it runs, status reports only genuine SDK lifecycle observations:

- `queued` while an earlier owner message is active;
- `working` after the SDK turn starts;
- `command` for command execution;
- `tests` when a command is recognizable verification;
- `completed`, `failed`, or `cancelled` at a genuine terminal outcome.

Reasoning events and command output are never exposed as progress. Claude may block with `controller.mjs wait --operation-id <uuid> --timeout <seconds>`, then read the bounded terminal `result`. Completed independent results retain the exact owner message for Phase 2 and return it from `controller result`; it is erased when Phase 2 completes or the cycle is abandoned. Stop remains blocked through queued/working Phase 1, an uninterrupted Phase 2 gap, and queued/working Phase 2. An owner mode transition marks a gap interrupted; `recover abandon --operation-id <phase1-id>` remains the explicit manual escape.

A `PostToolUse` `asyncRewake` hook can wake Claude when a submitted phase becomes terminal. Fabex permits only one live watcher per project; `wait` remains the reliable fallback because Claude Code creates a process for every asynchronous hook invocation and does not deduplicate them.

Read-only state commands and runner/operation claims wait up to about three seconds for a live state lock using bounded exponential backoff. They never steal or delete it. A timeout reports `lock-contention` with only PID, purpose, and lock age. `controller wait` treats transient lock ownership as normal and continues until the operation or caller timeout ends.

`controller wait` also retries `migration-deferred` within the same caller timeout (exit 3 on timeout), without migrating state owned by a live old-schema runner. Non-mutating host monitoring such as Monitor and TaskOutput remains available during deferral; project writes and arbitrary Bash remain denied.

Operations expose nullable `usage` with non-negative safe-integer `input_tokens`, `cached_input_tokens`, and `output_tokens` from `turn.completed`. Missing or invalid usage is unknown, not zero. These counts are not billing estimates. Reasoning and tool output remain excluded.

### SDK feature review

Adopted from the installed 0.153.4 SDK surface: creation-only `threadSource: "fabex"`, bounded completion usage, and the `persistent` reasoning-effort value (opt-in; the default is unchanged). Source classification aids identification but does not guarantee Desktop invisibility; resumed canonical threads are not reclassified. Recheck thread counts, runner processes, and RAM after activation. Version 1.7.0 now uses the previously available `local_image` and `outputSchema` capabilities for images and structured reviews. Comparing 0.149.0 and 0.153.4 types, only threadSource and persistent are new additions; usage, images, and structured output were already available. App-server-only features are not assumed to exist in this TypeScript SDK. The SDK continues to [start and resume local threads](https://learn.chatgpt.com/docs/codex-sdk).

Cancellation is explicit:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" cancel --operation-id <uuid>
```

Cancellation aborts the active `runStreamed()` call through `AbortSignal`, records `cancelled`, and retains the verified canonical thread ID for the next queued turn. Cancelling a queued operation removes its raw message before it reaches Codex.

If an operation is still marked `working` but its recorded runner PID is dead, `cancel` marks the outcome unknown and enters recovery-read-only instead of setting a cancellation flag that nobody can consume. `recover abandon` can perform that dead-runner transition and then explicitly release the abandoned record without starting another Codex turn.

## Continuous thread and restart behavior

The first SDK event for every turn must be `thread.started`. Fabex accepts the returned `thread_id` only when it creates the canonical thread; every resumed turn must return the exact persisted ID. A missing or mismatched ID fails closed.

Across controller or Claude restarts, Fabex reconstructs the bound milestone's SDK thread with `resumeThread(exactId, perTurnOptions)`. The official SDK cold-resumes threads persisted by the Codex CLI. Ordinary restart uses no empty re-sync turn, sibling thread, manual compaction call, or source rewrite. Explicit milestone selection or a reviewed linked continuation can select a different preserved thread.

A newer hook or status process never migrates persisted state while the already-loaded controller still owns a working operation and its PID is alive. Reads report `migration-deferred`, leave the old document untouched, and permit migration only after that runner exits. This prevents a live source update from invalidating the finishing runner's in-memory schema.

SDK developer instructions are deliberately route-neutral because a resumed Codex thread can retain its first developer message. Every first or resumed prompt begins with `FABEX TURN: phase=<phase>; route=<route>; sandbox=<sandbox>; participants=<participants>`. Phase 1 contains only the owner message and previous owner-visible reply. On a new replacement thread, the bounded prior checkpoint is supplied through initial developer configuration so it does not create a trailing Phase 1 prompt section. Mode changes never change the canonical ID.

The owner-selected mode is persisted separately from temporary recovery-read-only state. Abandon, confirmed missing-thread replacement, lock/transaction recovery, restart, and orphan recovery restore that proven selection and never touch the mode grant. If older or corrupt state cannot prove it, Fabex fails closed to discussion/both and rejects partner work until an owner mode command establishes a selection. Recovery output names the preserved route.

If the SDK returns the verified text `Session not found for thread_id: <id>`, Fabex enters recovery-read-only. Only the explicit `recover replace-missing-thread --operation-id <uuid>` path clears that confirmed-missing ID; the next owner turn creates one structured-checkpoint-seeded replacement. Other failures do not silently replace the thread.

## Structured checkpoint and recovery budget

Fabex no longer accumulates raw owner-goal history. Its checkpoint includes:

- objective;
- current task;
- constraints;
- accepted decisions;
- relevant files;
- implementation status;
- test status;
- unresolved problems;
- next action;
- repository fingerprint.

Continuation also records open work, any required owner action, a blocker and its
bounded continuation budget. Clearing a blocker does not waive review obligations.

The complete recovery seed—including title, framing, serialized checkpoint, and stale-repository warning—has a hard 48 KiB UTF-8 limit. Updates that would exceed 49,152 bytes are rejected atomically. `checkpoint capacity` reports counts and bytes, `checkpoint export` is the sanctioned full-text export, `checkpoint replace` and `compact` maintain arrays atomically, and `checkpoint snapshot` updates any subset of the five progress fields in one validated transaction. Tool/notification payloads are rejected. Status exposes only `updatedAt` and bounded warnings, never checkpoint text.

Array replacement and progress snapshots read JSON from guarded quoted heredocs. Executor exceptions use `executor-exception authorize --executor <name> --scope <scope> --reason <text>` and `executor-exception reconcile --outcome <text>`; their structured state remains authoritative even if accepted decisions are compacted.

## Requirements and dependency installation

- Claude Code 2.1.261 or newer (required for the 1.6 stable hook set)
- Node.js 20 or newer
- Codex CLI signed in through the owner's existing ChatGPT/Codex subscription

Fabex declares the official SDK in `package.json` and pins it to the same version in `package-lock.json` and `pnpm-lock.yaml`. The SDK brings its matching `@openai/codex` CLI package. Fabex does not bundle or commit `node_modules`.

Marketplace installation needs no manual dependency command: when Claude Code caches the plugin, it recognizes `package-lock.json` and runs `npm ci --ignore-scripts` automatically. The pnpm lock remains for contributor workflows. See the [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference.md#nodejs-package-dependencies).

Contributors working directly in the checkout use `pnpm install --frozen-lockfile` (pnpm 10 or newer) or `npm ci --ignore-scripts`.

Fabex has no API-key, base-URL, credential entry, or separate billing surface. It neither requests nor stores credentials and passes no `apiKey` to the SDK. It relies only on the existing Codex CLI ChatGPT subscription sign-in. If a future SDK or CLI requires API-key billing for this path, stop: that is a release blocker, not a fallback.

## Install

Install the public GitHub marketplace from Claude Code:

```text
/plugin marketplace add replayjapan/fabex
/plugin install fabex@fabex
```

The equivalent CLI commands are:

```sh
claude plugin marketplace add replayjapan/fabex
claude plugin install fabex@fabex
```

Claude Code installs the pinned Node dependency automatically. After installation, restart the session and run `/fabex:diagnose`.

For a development checkout:

```sh
git clone <FABEX-REPOSITORY-URL>
cd fabex
pnpm install --frozen-lockfile
claude plugin marketplace add "$(pwd)"
claude plugin install fabex@fabex
```

After an update, reload the plugin, run `/fabex:diagnose`, then perform the live dogfood criteria below. Do not point normal use at a mutable plugin cache.

### Submitting to Anthropic's marketplace

Before submission, verify the exact public candidate from its repository root:

```sh
claude plugin validate .
```

Then submit its public repository through the [Anthropic Console plugin form](https://platform.claude.com/plugins/submit). Fabex remains Beta until the dogfood criteria below pass, so an official listing should wait for that evidence. See Anthropic's [plugin creation](https://code.claude.com/docs/en/plugins.md) and [plugin discovery](https://code.claude.com/docs/en/discover-plugins.md) documentation.

### Upgrading an installed checkout

Claude Code caches plugins under `<claude config dir>/plugins/cache/<marketplace>/<plugin>/<version>/`; `${CLAUDE_PLUGIN_ROOT}` points to that cache copy, not the source checkout. After bumping `plugin.json`, update the marketplace with `/plugin marketplace update fabex` or `claude plugin marketplace update fabex`, reinstall or force-reload with `/reload-plugins --force`, and restart the session because hooks and MCP servers are read at startup. `diagnose` reports the registry version, install path, and whether they match the loaded source. See the [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference.md).

## Configuration

Configuration merges field by field from shipped defaults, machine `FABEX_HOME` config, then project `.fabex/config.json`:

```json
{
  "schemaVersion": 1,
  "models": {
    "codex": { "model": null, "reasoningEffort": "high", "networkAccessEnabled": false },
    "operational": "sonnet"
  },
  "collaboration": { "jointByDefault": true },
  "display": { "replyModeBadge": "always" },
  "project": { "repositoryRoot": "app" },
  "guard": {
    "allowedCommands": [],
    "allowedCommandPatterns": [
      {"executable":"pnpm","args":["test:e2e"]},
      {"executable":"node","args":["scripts/review-screenshots.mjs"]}
    ],
    "externalWriteRoots": ["/absolute/team-artifacts"],
    "readOnlyMcpTools": ["mcp__context7__*", "mcp__ide__getDiagnostics"]
  }
}
```

`project.repositoryRoot` is accepted only in the project layer and must be a relative path inside the workstream; Fabex never guesses between nested repositories. `models.codex.networkAccessEnabled` defaults off and affects only `workspace-write` turns; read-only turns remain offline. Fabex never selects `danger-full-access`.

`guard.allowedCommandPatterns` and `allowedCommands` remain compatible for existing narrow paths, but routine work no longer requires them. Neither proves read-only effects in discussion. Scratch-root validation remains in read-only routes; source-rewrite flags still belong to Codex.

`guard.externalWriteRoots` adds absolute or `~`-prefixed scratch/artifact roots. Defaults are derived at runtime for the OS temporary directory, Claude project memory, and Claude session scratchpads. Bash output is allowed only when one absolute target is outside the workstream, inside a permitted root, contains no substitution, and uses a quoted heredoc or simple `echo`/`printf`/`cat` redirect. Append mode is scoped by the same rule and is never enabled generally.

Task status is non-sticky: submission and successful completion are `active`; an ordinary failed turn becomes `partner-unavailable`; ambiguous or missing-thread recovery becomes `recovery-required`; and recovery abandonment or confirmed replacement returns to `active` when work remains, otherwise `null`.

## Privacy and retention

Per-workstream state is stored under the plugin data directory with restrictive permissions. A mode command temporarily retains its trailing owner text until the transition succeeds; a completed independent turn retains that owner message until Phase 2 completes or the cycle is abandoned. Other terminal prompts and all terminal attachment paths are erased. Fabex retains the structured checkpoint, bounded structured reviews, and normally at most 24 terminal records. Linked phases are pruned together, with additional byte-budget pruning; unrelayed answers and unfinished cycles are protected, so retention may exceed 24 but never the hard 1 MiB state limit. New writes fail visibly if that limit is reached. Context state retains SHA-256 digests, byte counts, timestamps and session identifiers; the private 1.9.2 owner-prompt sidecar also retains eligible original text for forwarding. Relay acknowledgements retain only session, label, and status beside the already-stored answer. The owner-prompt sidecar retains at most eight records and 2 MiB, with at most 192 KiB of raw text per eligible message, private mode 0600 and no raw Claude-only Q&A. Fabex does not store image bytes, a full Codex transcript, reasoning events, command output, compaction summaries, notification payloads, or raw Claude-only Q&A.

The SDK and Codex CLI persist the canonical thread under Codex's own storage and may retain data under their policies. Claude Code and host applications may retain their own data independently.

## Status, recovery, and guards

`/status` reports mode, participants, state health, controller PID/active operation, canonical thread ID, metadata, recovery-seed byte count, separately timestamped captured and live repository fingerprints, and bounded lifecycle records. Default output includes active/queued operations plus the last three terminal records; `status --all` shows all retained records and `status --brief` omits controller and operation history. Fingerprint differences warn without mutating state. It omits checkpoint text, queued messages, final responses, transcripts, environment values, and credentials.

`/recover` can inspect an operation without exposing its retained queued text, abandon a failed/cancelled record, explicitly replace only a confirmed-missing thread, clear only a confirmed-dead lock, and commit/discard only a validated unambiguous transaction. State files must never be hand-edited.

The route guard parses exact invoked script paths and argv rather than matching command substrings. It rejects malformed two-phase envelopes before queueing, denies AI calls to mode-changing skills, validates owner mode grants on Bash calls, gates controller/checkpoint controls, and retains direct source-authorship checks; work Bash/MCP backstops do not prove arbitrary program effects. The mode command independently consumes the grant, covering direct Codex sandbox attempts that Claude hooks cannot observe. Main-session or optional operational-agent delivery is available in work mode under host permissions.

Fabex 1.7.0 uses documented stable hook events: `UserPromptExpansion`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, and `PostCompact`. Operational subagent hooks record start/finish metadata and a result digest. PostCompact stores only its trigger and timestamp, warning when the checkpoint predates compaction. Fabex does not depend on preview function hooks. See the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks.md).

## Beta dogfood and release criteria

1. Verify every joint owner message reaches the same `thread_id`, including after Claude and controller restarts.
2. Verify discussion and ask use `read-only`, implementation uses `workspace-write`, and the ID does not change.
3. Verify current Fable text is absent from Phase 1, Phase 2 links the stored result, and later owner cycles cannot cross the barrier.
4. Verify owner-typed mode commands work once while Claude main, subagents, and Codex cannot change modes themselves.
5. Cancel an active phase, recover an abandoned Phase 2 gap, and verify continuity on the same ID.
6. Verify Stop reply digests, operational lifecycle, compaction stamps, and optional wake behavior after reload.
7. Watch Codex Desktop thread count. SDK exec-source sessions are expected to stay out of Desktop's default Recents; this is a hard criterion, not a documented platform guarantee.
8. Watch Codex/Node process accumulation and RAM during repeated two-phase turns and restarts.

If Desktop thread flooding, orphaned sessions/processes, or material RAM growth returns, stop dogfooding and adjust the transport before release. No live dogfood, plugin reload, or Codex Desktop inspection is performed by the isolated repository test suite.

## Release activation status

Version 1.8.0 is implemented in this repository. Until a successful turn is recorded on this version, activation is unknown. `diagnose` reports source and installed versions, hook validity, whether reload is provably required, and the last successfully recorded Fabex turn/version. Schema 13 adds pending-grant images, bounded recorded replies and submission digests, preserving schema-12 queued images, results and canonical identity. The live-runner migration gate remains in place. Update, force plugin reload, and restart before running the [live acceptance checks](docs/acceptance-1.8.0.md). Fabex remains Beta and is not yet marketplace-ready.

## Platform support

macOS supported; Windows experimental. Platform behavior remains subject to Claude Code, the official SDK, and Codex CLI limits.

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
