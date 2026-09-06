# Fabex — Beta

> **Beta:** Fabex 1.7.0 is being dogfooded. Do not treat it as marketplace-ready until the live two-phase continuity, hook activation, Codex Desktop visibility, process, and RAM criteria below pass.

Fabex keeps Claude/Fable as the owner-facing interface while Claude and Codex collaborate as equal partners. Every both-participant owner cycle uses two turns on one continuous Codex thread: Codex first records an independent reading, then reviews Fable's owner-visible response. Codex remains the implementation agent, and a bounded operational agent handles GitHub delivery chores. Private reasoning and tool logs are never relayed.

## What 1.7.0 changes

Fabex uses the official TypeScript `@openai/codex-sdk`, pinned with its CLI runtime to 0.153.4. Release 1.7.0 adds image attachments to both phases, structured reviews, and complete labeled verbatim relay with Stop verification. Independent-first sequencing, owner-only grants, canonical continuity, and security boundaries remain unchanged. Permission profiles were reviewed but not enabled: they cannot be layered safely over the current sandbox selection.

Fabex leaves the Codex model unset by default so Codex inherits the owner's configuration; an explicit `models.codex.model` overrides it. `diagnose` reports the model source as `Fabex config`, `Codex config default`, or `unknown`. The configuration reading is not verification of the model that served a turn; profile-based or unavailable resolution is unknown. With no configured model, the bundled CLI default can change on upgrade (0.153.4 changes it to Astra). Fabex does not alter the owner's model setting. See the [official Codex changelog](https://learn.chatgpt.com/docs/changelog).

Speaker labels use model family names only, for example `Claude (Fable):` and `Codex (Astra):`. Claude's name comes from SessionStart model metadata; Codex's comes from known configuration. Unknown models produce `Claude:` or `Codex:`. Labels accompany, never modify, verbatim relay bodies:

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

Questions authorize answers only. Codex performs project edits. Claude coordinates and verifies. Normal-mode project writes by Claude main sessions and subagents—including file tools, Bash, and mutating MCP tools—are allowlist-controlled unless a structured owner-named executor exception is active. Only the verified plugin-scoped `fabex:fabex-operational` agent may perform Git add, commit, tag, merge, rebase, cherry-pick, push, send-pack, Git LFS push, or `gh` sequences.

Mode commands are owner-only. Typing a Fabex mode slash command fires `UserPromptExpansion`, which issues a grant bound to that session, project, route, and participant set. Optional same-line or multiline text is captured byte-for-byte in private grant state; it is not interpolated into Fable's expanded prompt. The atomic mode command validates the grant, applies the route, consumes the grant, and only then exposes or submits the owner text. Both-participant text becomes a fresh independent Phase 1; Codex-only text becomes one read-only relay turn; Claude-only text is printed to Fable only after the transition. No text means no empty operation. AI-issued mode skills, missing grants, mismatches, and replays fail closed.

An owner mode command supersedes a completed Phase 1 that is still awaiting reconciliation: Fabex retains and marks that reading interrupted, so Stop no longer blocks on it. If a Codex operation is active, the transition and its text remain durable, grant expiry pauses, and the transition applies only after that operation stops. Old queued work is cancelled. A switch to discussion cannot later release workspace-write work from the interrupted cycle.

### Host ARGUMENTS limitation

Claude Code was observed appending an `ARGUMENTS` section itself in 1.6.1, exposing owner text to Fable before Phase 1. The 1.6.2 expansion hook preserves the exact text in grant state and returns an `updatedInput` candidate without that suffix, or the trusted packaged skill body when only the original command is available. Current documentation is inconsistent with the reported rewrite capability: the [UserPromptExpansion reference](https://code.claude.com/docs/en/hooks#userpromptexpansion-decision-control) describes blocking and additional context, not a guaranteed rewrite. Live dogfood reported that the host ignored this candidate and still delivered ARGUMENTS. Early Fable visibility is therefore a known platform limitation; Codex still receives only the private independent Phase 1 input. Do not claim early Fable blindness based on the unit test alone.

## Mechanically enforced and platform-limited behavior

### Images and structured reviews

Both strict JSON phase envelopes accept an optional `attachments` array, for example `"attachments": ["/absolute/workspace/app/review.png"]`. The owner or Fable may supply approved image paths; Phase 1 must not include current Fable annotations or opinions disguised as screenshots. Fable-generated current analysis belongs only in Phase 2. This semantic boundary remains instructional: path validation cannot prove who authored an image.

At most six PNG, JPG/JPEG, WebP, or GIF files are allowed, each nonempty and at most 8 MiB. Paths must be absolute and resolve inside the workstream (including its configured repository) or an effective `guard.externalWriteRoots` directory. Symlink escapes are rejected. Files are checked at submission and immediately before execution; supplied files should remain unchanged while queued. The SDK receives `local_image` inputs alongside the phase text, including in read-only discussion and ask. Fabex stores paths only until completion, failure, or cancellation; it never stores image bytes in state. SDK/model processing and persisted Codex history have separate retention; removing Fabex paths does not erase those copies. Share only images approved for sending to Codex.

Every both-participant phase requests `outputSchema` fields: `scopeMismatch`, `parityConcern`, `answer`, `evidence`, `assumptions`, `uncertainties`, `recommendation`, `changedFiles`, and `tests` (`command`, `exitCode`; null means not known). Reconciliation also requires `disagreements`. `answer` is Codex's complete owner-facing answer, including flags, not a summary derived by Fable. The controller retains the validated object in `result.structured` and the exact answer in `result.finalResponse`. Invalid JSON or schema output falls back to the raw response with `structured: null` and an explicit warning; it does not itself fail the operation. Codex-only turns retain free text.

Answers have the existing 32 KiB storage bound. Structured objects have a 48 KiB total bound, 16 entries per array, and 2048 bytes per supplemental string. Overflow falls back visibly, and truncation is explicitly labeled rather than called a complete quote. Token usage is not a context-capacity or billing meter.

### Complete verbatim relay

`controller.mjs result --operation-id <uuid>` returns `relayBlock`: the Codex label and phase, every stored answer line quoted, then the structured fields and any warning. Paste each phase's block unchanged before Fable's separate view or a joint summary. Never call an excerpt a full quote. Phase 2 corrections must remain separately visible; a Phase 1 quote alone is not necessarily Codex's final position. Only owner-facing text is relayed, never private reasoning or tool logs.

Stop checks pending completed phases for the current session against `last_assistant_message`, normalizing whitespace and blockquote prefixes. Missing full answers or speaker labels block stopping; an accepted Stop acknowledges them so later turns need not repeat old answers. This checks textual presence, not whether the UI actually displayed it, its ordering, or spoken playback. Pending unrelayed answers are protected from history pruning; the hard state budget still fails closed if too much undelivered content accumulates.

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
| Claude executor project-write, Bash, and MCP allowlists | Complete continuity after an explicitly replaced missing session |
| Full Git delivery lane limited to the plugin-scoped operational agent | Codex compliance with the instruction reserving delivery for `fabex-operational` |
| Atomic schema migration and hard 48 KiB complete recovery seed | Resource use of SDK/CLI processes under live workloads |

## Independent-first controller and progress visibility

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

`UserPromptSubmit` records a digest, byte count, time, and session for owner prompts. Notification-shaped inputs containing task, system, reminder, or local-command markers are ignored. An eight-entry private digest-only sidecar lets a legitimate owner prompt survive interleaved background notifications or a second queued owner prompt; the canonical schema remains unchanged. Stop records the same metadata for the final owner-visible Fable reply. Fabex compares these when available but stores no text copy and never parses transcripts. Interruptions and unavailable hook evidence are reported honestly rather than guessed.

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

Across controller or Claude restarts, Fabex reconstructs the SDK thread with `resumeThread(exactId, perTurnOptions)`. The official SDK cold-resumes threads persisted by the Codex CLI. No empty re-sync turn, sibling thread, manual compaction call, or source rewrite is used.

A newer hook or status process never migrates persisted state while the already-loaded controller still owns a working operation and its PID is alive. Reads report `migration-deferred`, leave the old document untouched, and permit migration only after that runner exits. This prevents a live source update from invalidating the finishing runner's in-memory schema.

SDK developer instructions are deliberately route-neutral because a resumed Codex thread can retain its first developer message. Every first or resumed prompt begins with `FABEX TURN: phase=<phase>; route=<route>; sandbox=<sandbox>; participants=<participants>`. Phase 1 contains only the owner message and previous owner-visible reply. On a new replacement thread, the bounded prior checkpoint is supplied through initial developer configuration so it does not create a trailing Phase 1 prompt section. Mode changes never change the canonical ID.

The owner-selected mode is persisted separately from temporary recovery-read-only state. Abandon, confirmed missing-thread replacement, lock/transaction recovery, restart, and orphan recovery restore that proven selection and never touch the mode grant. If older or corrupt state cannot prove it, Fabex fails closed to discussion/both and rejects partner work until an owner mode command establishes a selection. Recovery output names the preserved route.

If the SDK returns the verified text `Session not found for thread_id: <id>`, Fabex enters recovery-read-only. Only the explicit `recover replace-missing-thread --operation-id <uuid>` path clears that confirmed-missing ID; the next owner turn creates one structured-checkpoint-seeded replacement. Other failures do not silently replace the thread.

## Structured checkpoint and recovery budget

Fabex no longer accumulates raw owner-goal history. Its checkpoint has exactly these fields:

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

`guard.allowedCommandPatterns` matches parsed argv exactly after leading environment assignments. Each argument is literal or the documented one-token wildcard `"*"`; no regex or substring matching is accepted. Relative Node script paths resolve against `repositoryRoot` and cannot escape the workstream. `allowedCommands` remains compatible, but each bare executable grants every invocation and triggers a config/diagnose warning; migrate broad entries such as `"node"` to exact script patterns. Built-in package-manager verification accepts `test`, safe `test:<name>`, `lint`, `typecheck`, `build`, `check`, and corresponding `run` forms, but rejects update, write, fix, and force flags. Built-in `node --test` accepts automatic discovery or explicit test paths only inside the configured repository/workstream; outside paths and additional Node flags require an exact configured pattern.

`guard.externalWriteRoots` adds absolute or `~`-prefixed scratch/artifact roots. Defaults are derived at runtime for the OS temporary directory, Claude project memory, and Claude session scratchpads. Bash output is allowed only when one absolute target is outside the workstream, inside a permitted root, contains no substitution, and uses a quoted heredoc or simple `echo`/`printf`/`cat` redirect. Append mode is scoped by the same rule and is never enabled generally.

Task status is non-sticky: submission and successful completion are `active`; an ordinary failed turn becomes `partner-unavailable`; ambiguous or missing-thread recovery becomes `recovery-required`; and recovery abandonment or confirmed replacement returns to `active` when work remains, otherwise `null`.

## Privacy and retention

Per-workstream state is stored under the plugin data directory with restrictive permissions. A mode command temporarily retains its trailing owner text until the transition succeeds; a completed independent turn retains that owner message until Phase 2 completes or the cycle is abandoned. Other terminal prompts and all terminal attachment paths are erased. Fabex retains the structured checkpoint, bounded structured reviews, and normally at most 24 terminal records. Linked phases are pruned together, with additional byte-budget pruning; unrelayed answers and unfinished cycles are protected, so retention may exceed 24 but never the hard 1 MiB state limit. New writes fail visibly if that limit is reached. Context hooks retain SHA-256 digests, byte counts, timestamps, and session identifiers—not message copies. Relay acknowledgements retain only session, label, and status beside the already-stored answer. The owner-prompt sidecar retains at most eight such digest records and no prompt text. Fabex does not store image bytes, a full Codex transcript, reasoning events, command output, compaction summaries, notification payloads, or raw Claude-only Q&A.

The SDK and Codex CLI persist the canonical thread under Codex's own storage and may retain data under their policies. Claude Code and host applications may retain their own data independently.

## Status, recovery, and guards

`/status` reports mode, participants, state health, controller PID/active operation, canonical thread ID, metadata, recovery-seed byte count, separately timestamped captured and live repository fingerprints, and bounded lifecycle records. Default output includes active/queued operations plus the last three terminal records; `status --all` shows all retained records and `status --brief` omits controller and operation history. Fingerprint differences warn without mutating state. It omits checkpoint text, queued messages, final responses, transcripts, environment values, and credentials.

`/recover` can inspect an operation without exposing its retained queued text, abandon a failed/cancelled record, explicitly replace only a confirmed-missing thread, clear only a confirmed-dead lock, and commit/discard only a validated unambiguous transaction. State files must never be hand-edited.

The route guard parses exact invoked script paths and argv rather than matching command substrings. It rejects malformed two-phase envelopes before queueing, denies AI calls to mode-changing skills, validates owner mode grants on Bash calls, gates controller/checkpoint controls, and allowlists the three project-mutation channels: file tools, Bash, and MCP. The mode command independently consumes the grant, covering direct Codex sandbox attempts that Claude hooks cannot observe. The entire Git delivery lane remains reserved for the operational agent.

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

Version 1.7.0 is implemented in this repository. Until a successful turn is recorded on this version, activation is unknown. `diagnose` reports source and installed versions, hook validity, whether reload is provably required, and the last successfully recorded Fabex turn/version. Schema 11 adds bounded structured results, transient attachment paths, and relay acknowledgements without losing prior state. Update, force plugin reload, and restart before activation testing; test both image phases, complete verbatim Stop acknowledgement, and the owner-requested interruption escape. Fabex remains Beta and is not yet marketplace-ready.

## Platform support

macOS supported; Windows experimental. Platform behavior remains subject to Claude Code, the official SDK, and Codex CLI limits.

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
