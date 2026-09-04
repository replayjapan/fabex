# Fabex — Beta

> **Beta:** Fabex 1.5.0 is being dogfooded. Do not treat it as marketplace-ready until the live continuity, Codex Desktop visibility, process, and RAM criteria below pass.

Fabex keeps Claude/Fable as the owner-facing interface while Claude and Codex collaborate as equal partners. Every owner message in a joint or Codex-participant mode is queued onto one continuous Codex thread; Codex remains the implementation agent, and a bounded operational agent handles GitHub delivery chores. Owner-visible Claude replies are shared verbatim with Codex on the next turn; private reasoning and tool logs are never relayed.

## What 1.5.0 changes

Fabex uses the official TypeScript `@openai/codex-sdk`. Release 1.5.0 hardens long projects: bidirectional owner-visible context, atomic checkpoint maintenance and freshness warnings, structured executor exceptions, explicit repository roots, strict Bash/MCP/Git allowlists, opt-in local network access, blocking operation waits, installed-version diagnosis, and an authoritative per-turn route header.

There is no MCP compatibility lane. The old `.mcp.json`, MCP adapter, result hook, structured-content recorder, and begin-authorized tool protocol were removed.

## Modes

| Command | Route | Participants | Codex SDK turn | Mechanical SDK sandbox |
| --- | --- | --- | --- | --- |
| `/work` | normal | Claude + Codex | Every owner message | `workspace-write` |
| `/workClaude` | normal | Claude | Implementation switches to joint mode | none until joint work |
| `/discussion` | discussion | Claude + Codex | Every owner message | `read-only` |
| `/discussionClaude` | discussion | Claude | none | none |
| `/discussionCodex` | discussion | Codex relay | Every owner message | `read-only` |
| `/ask` | ask-once | Claude + Codex | One owner question | `read-only` |
| `/askClaude` | ask-once | Claude | none | none |
| `/askCodex` | ask-once | Codex relay | One owner question | `read-only` |

Questions authorize answers only. Codex performs project edits. Claude coordinates and verifies. Normal-mode project writes by Claude main sessions and subagents—including file tools, Bash, and mutating MCP tools—are allowlist-controlled unless a structured owner-named executor exception is active. Only the verified plugin-scoped `fabex:fabex-operational` agent may perform Git add, commit, tag, merge, rebase, cherry-pick, push, send-pack, Git LFS push, or `gh` sequences.

## Mechanically enforced and platform-limited behavior

| Mechanically enforced | Instructional or platform-limited |
| --- | --- |
| Exact controller submit/status/result/cancel/wait command shapes | Equal model judgment and memory quality |
| Durable per-workstream FIFO queue and one active turn | Perfect current-turn opinion separation while progress is asynchronous |
| Exact `thread.started` ID verification on every turn | SDK/CLI service availability and subscription limits |
| Per-turn `read-only` or `workspace-write` SDK sandbox | Codex Desktop Recents visibility across future app versions |
| Claude-only denial of SDK submit | Host model resolution for `fabex-operational` |
| Claude executor project-write, Bash, and MCP allowlists | Complete continuity after an explicitly replaced missing session |
| Full Git delivery lane limited to the plugin-scoped operational agent | Codex compliance with the instruction reserving delivery for `fabex-operational` |
| Atomic schema migration and hard 48 KiB complete recovery seed | Resource use of SDK/CLI processes under live workloads |

## Controller and progress visibility

The joint workflow submits a short single-line owner message with:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" submit --message '<owner message>'
```

For multiline or shell-significant text, the skill uses a guard-validated quoted heredoc with a fresh delimiter, preserving the body without interpolation. The submitted body contains `OWNER MESSAGE (verbatim):` and, when available, `CLAUDE REPLY (owner-visible, verbatim):`; it excludes private reasoning and tool logs.

Submission returns a UUID immediately. While the operation runs, status reports only genuine SDK lifecycle observations:

Owner messages are limited to 192 KiB so an initial turn plus the maximum 48 KiB recovery seed remains below the former 256 KiB failure boundary.

- `queued` while an earlier owner message is active;
- `working` after the SDK turn starts;
- `command` for command execution;
- `tests` when a command is recognizable verification;
- `completed`, `failed`, or `cancelled` at a genuine terminal outcome.

Reasoning events and command output are never exposed as progress. Claude may poll with `status`, or block without polling hacks using `controller.mjs wait --operation-id <uuid> --timeout <seconds>`, then read the bounded terminal `result`. A busy controller keeps later messages in durable FIFO order and processes them sequentially on the same thread; v1 has no mid-turn steering.

Cancellation is explicit:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/controller.mjs" cancel --operation-id <uuid>
```

Cancellation aborts the active `runStreamed()` call through `AbortSignal`, records `cancelled`, and retains the verified canonical thread ID for the next queued turn. Cancelling a queued operation removes its raw message before it reaches Codex.

## Continuous thread and restart behavior

The first SDK event for every turn must be `thread.started`. Fabex accepts the returned `thread_id` only when it creates the canonical thread; every resumed turn must return the exact persisted ID. A missing or mismatched ID fails closed.

Across controller or Claude restarts, Fabex reconstructs the SDK thread with `resumeThread(exactId, perTurnOptions)`. The official SDK cold-resumes threads persisted by the Codex CLI. No empty re-sync turn, sibling thread, manual compaction call, or source rewrite is used.

SDK developer instructions are deliberately route-neutral because a resumed Codex thread can retain its first developer message. Every first or resumed prompt begins with `FABEX TURN: route=<route>; sandbox=<sandbox>; participants=<participants>`, followed by the owner-visible message envelope. This header is authoritative for the current turn. Mode changes never change the canonical ID.

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

- Claude Code with local plugin support
- Node.js 20 or newer
- pnpm 10 or newer, or a compatible npm client
- Codex CLI signed in through the owner's existing ChatGPT/Codex subscription

Fabex declares the official SDK in the plugin's `package.json` and pins it in `pnpm-lock.yaml`. The SDK brings its matching `@openai/codex` CLI package. Fabex does not bundle or commit `node_modules`; install the pinned dependency into the plugin checkout before installing or reloading the plugin:

```sh
pnpm install --frozen-lockfile
```

For npm-based environments, `npm install` from the plugin root installs the same declared dependency, though the committed pnpm lockfile is the release authority.

Fabex has no API-key, base-URL, credential entry, or separate billing surface. It neither requests nor stores credentials and passes no `apiKey` to the SDK. It relies only on the existing Codex CLI ChatGPT subscription sign-in. If a future SDK or CLI requires API-key billing for this path, stop: that is a release blocker, not a fallback.

## Install

The public marketplace location is not assigned. For a development checkout:

```sh
git clone <FABEX-REPOSITORY-URL>
cd fabex
pnpm install --frozen-lockfile
claude plugin marketplace add "$(pwd)"
claude plugin install fabex@fabex
```

After an update, reload the plugin, run `/fabex:diagnose`, then perform the live dogfood criteria below. Do not point normal use at a mutable plugin cache.

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
    "readOnlyMcpTools": ["mcp__context7__*", "mcp__ide__getDiagnostics"]
  }
}
```

`project.repositoryRoot` is accepted only in the project layer and must be a relative path inside the workstream; Fabex never guesses between nested repositories. `models.codex.networkAccessEnabled` defaults off and affects only `workspace-write` turns; read-only turns remain offline. Fabex never selects `danger-full-access`. Guard command and MCP allowlists may be extended per project. `models.operational` must be passed explicitly when creating `fabex-operational`.

Task status is non-sticky: submission and successful completion are `active`; an ordinary failed turn becomes `partner-unavailable`; ambiguous or missing-thread recovery becomes `recovery-required`; and recovery abandonment or confirmed replacement returns to `active` when work remains, otherwise `null`.

## Privacy and retention

Per-workstream state is stored under the plugin data directory with restrictive permissions. A queued raw owner message is retained only until its operation becomes terminal, then erased. Fabex retains the structured checkpoint and at most 24 terminal operation records with bounded final response/error fields; it does not store a full Codex transcript, reasoning events, command output, or raw Claude-only Q&A.

The SDK and Codex CLI persist the canonical thread under Codex's own storage and may retain data under their policies. Claude Code and host applications may retain their own data independently.

## Status, recovery, and guards

`/status` reports mode, participants, state health, controller PID/active operation, canonical thread ID, metadata, recovery-seed byte count, current repository fingerprint, and bounded lifecycle records. It omits checkpoint text, queued messages, final responses, transcripts, environment values, and credentials.

`/recover` can inspect an operation without exposing its retained queued text, abandon a failed/cancelled record, explicitly replace only a confirmed-missing thread, clear only a confirmed-dead lock, and commit/discard only a validated unambiguous transaction. State files must never be hand-edited.

The route guard parses exact invoked script paths rather than matching command substrings. It gates controller and checkpoint controls, keeps Claude-only denial semantics, and allowlists the three project-mutation channels: file tools, Bash, and MCP. Safe read/verification pipelines are accepted when every segment is allowlisted; other host orchestration tools defer because any project mutation they initiate is checked again under the responsible executor. The entire Git delivery lane remains reserved for the operational agent. Structured executor exceptions are independent of checkpoint decision prose.

## Beta dogfood and release criteria

1. Verify every joint owner message reaches the same `thread_id`, including after Claude and controller restarts.
2. Verify discussion and ask use `read-only`, implementation uses `workspace-write`, and the ID does not change.
3. Queue messages during a long turn and verify FIFO processing and visible lifecycle transitions.
4. Cancel an active turn, submit another message, and verify continuity on the same ID.
5. Watch Codex Desktop thread count. SDK exec-source sessions are expected to stay out of Desktop's default Recents; this is a hard criterion, not a documented platform guarantee.
6. Watch Codex/Node process accumulation and RAM during repeated turns and restarts.

If Desktop thread flooding, orphaned sessions/processes, or material RAM growth returns, stop dogfooding and adjust the transport before release. No live dogfood, plugin reload, or Codex Desktop inspection is performed by the isolated repository test suite.

## Release activation status

Version 1.5.0 is implemented in this repository. Unit and mock-integration verification can complete without live model calls, but activation remains pending install/reload and the Beta dogfood criteria. Fabex is not yet marketplace-ready.

## Platform support

macOS supported; Windows experimental. Platform behavior remains subject to Claude Code, the official SDK, and Codex CLI limits.

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
