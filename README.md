# Fabex

Keep the quality of a two-model Fable workflow while Codex carries the coding load.

Fabex connects Claude and Codex as practical partners through one canonical Codex MCP thread. Within documented platform and behavioral limits, both receive owner-visible joint turns and accepted decisions, both may flag scope or parity problems, Codex performs project edits, and Claude coordinates and verifies.

No collaboration framework can guarantee equal memory, judgment, availability, model behavior, or platform presentation. Fabex mechanically enforces only the controls listed below and states the remaining limits plainly.

## Executor authority

- Codex performs every project file edit through the canonical MCP thread.
- The bounded `fabex-operational` agent performs every GitHub or `gh` command sequence, including delivery preflight, staging, commit, and push. Fabex reads `models.operational` and requires that model to be passed explicitly when the agent is created.
- Claude coordinates and verifies. Its main-session Write/Edit/NotebookEdit calls are denied in normal Fabex mode.

Owner approval authorizes an action but never changes its prescribed executor. An exception is valid only when the owner explicitly names the alternate executor and Fabex records bounded authorization before use and reconciliation afterward. The push guard continues to allow protected GitHub operations only for a verified plugin-scoped `fabex:fabex-operational` subagent. Bash cannot be classified as universally mutating or read-only, so command discipline remains a documented limitation.

## Modes

| Skill | Route | Participants | Effect and limit |
| --- | --- | --- | --- |
| `/work` | normal | both | Joint work on the canonical thread; Codex edits |
| `/workClaude` | normal | Claude | Claude-only conversation; implementation switches to joint work |
| `/discussion` | discussion | both | Joint discussion; no-effects behavior is instructed, not sandbox-switched |
| `/discussionClaude` | discussion | Claude | Claude-only read-only discussion |
| `/discussionCodex` | discussion | Codex | Codex relay; no-effects behavior is instructed |
| `/ask` | ask-once | both | One joint no-effects answer, then restore |
| `/askClaude` | ask-once | Claude | One Claude-only answer, then restore |
| `/askCodex` | ask-once | Codex | One Codex relay answer, then restore |

The Codex MCP `codex-reply` tool cannot change sandbox, approval policy, model, or working directory. To preserve memory across mode changes, Fabex creates the canonical thread once with `workspace-write`. Discussion and ask modes are therefore behaviorally read-only through explicit instructions; they do not mechanically remove the thread's write capability.

## Continuous Codex memory

The first Codex-including owner turn lazily creates one canonical thread. Its first prompt begins with:

```text
Fabex partner — <project> — continuous session
```

All later work, discussion, and ask turns use `mcp__codex__codex-reply` with the exact persisted `threadId`. Mode changes never create sibling threads. Calls serialize per workstream, and the synchronous MCP response must return the matching structured `threadId` before Fabex accepts it.

A Codex turn can run for many minutes with no visible progress while the synchronous MCP call is in flight; this is normal, so prefer milestone-sized requests.

Fabex stores a bounded checkpoint containing recent joint owner goals, accepted decisions, relevant current status, repository fingerprint, and continuity metadata. Raw Claude-only questions and answers are neither relayed to Codex nor placed in its restart seed. Owner-approved decisions and relevant bounded status may still be recorded while Claude-only.

### Restart disclaimer

MCP transport lifetime follows the hosting Claude session. On SessionStart, Fabex makes no model call; it marks the next real Codex turn for one best-effort exact-ID `codex-reply` reattachment. Cross-restart reattachment is not a documented guarantee. If the thread is definitively unavailable, Fabex permits at most one visible checkpoint-seeded replacement. Missing or mismatched IDs, interruption, timeout, and ambiguous failure remain fail-closed in recovery-read-only.

The checkpoint is disaster recovery, not full transcript memory. A replacement can preserve recorded goals, decisions, and status but cannot recreate unrecorded reasoning or exact conversation history.

Codex MCP sessions are not currently expected to flood ordinary Codex Desktop recents, but invisibility and resource behavior are not guaranteed platform contracts. Do not market Fabex as preventing Codex Desktop sessions or memory use.

## Mechanically enforced and instructional behavior

| Mechanically enforced | Instructional or platform-limited |
| --- | --- |
| Exact `mcp__codex__codex` and `mcp__codex__codex-reply` gating | Codex compliance with no-effects discussion prompts |
| Canonical returned-threadId verification | Equal model judgment and memory |
| Per-workstream call serialization | Perfect current-turn opinion blindness with synchronous tools |
| Claude-only denial of Codex MCP tools | Bash mutation classification outside protected GitHub commands |
| Normal-mode Claude main-session Write/Edit/NotebookEdit denial | Operational-agent model resolution by the host runtime |
| Main-session and ambiguous-executor GitHub push denial | MCP visibility and resource behavior in Codex Desktop |
| Atomic schema migration and bounded terminal-operation pruning | Cross-restart MCP reattachment |
| Fail-closed state on ambiguous outcomes | Complete continuity after checkpoint replacement |

## Requirements and MCP setup

- Claude Code with plugin MCP support
- Codex CLI with `codex mcp-server`
- Node.js 20 or newer

The retired Codex companion plugin is neither required nor used.

Install the Codex CLI using an official method, sign in using the Codex CLI, and confirm this command exists:

```sh
codex mcp-server --help
```

Fabex ships `.mcp.json` with this stdio server:

```json
{
  "mcpServers": {
    "codex": {
      "command": "codex",
      "args": ["mcp-server"]
    }
  }
}
```

Fabex never requests, stores, inspects, sanitizes, or configures credentials; it uses the authentication already configured for the installed Codex CLI.

After installation or update, reload plugins, run `/fabex:diagnose`, and confirm both `mcp__codex__codex` and `mcp__codex__codex-reply` are exposed before the first Codex task.

## Install

The public marketplace location is not assigned yet. The following is a development placeholder, not a working marketplace URL:

```sh
claude plugin marketplace add <FUTURE-FABEX-MARKETPLACE-REPO-OR-PATH>
claude plugin install fabex@fabex
```

For local development, substitute the checked-out repository path. Do not point normal use at a mutable plugin cache.

## Configuration

No configuration is required. Configuration merges field by field from shipped defaults, the machine `FABEX_HOME` config, then project `.fabex/config.json`.

```json
{
  "schemaVersion": 1,
  "models": {
    "codex": {
      "model": null,
      "reasoningEffort": "high"
    },
    "operational": "sonnet"
  },
  "collaboration": {
    "jointByDefault": true
  },
  "display": {
    "replyModeBadge": "always"
  }
}
```

`models.codex` applies when the canonical thread is created; MCP replies inherit that thread's fixed settings. `models.operational` defaults to Sonnet, remains configurable, and is passed explicitly at agent creation. Host model substitution may be reported or remain unverifiable, so Fabex does not promise that the configured operational model is always cheaper.

## Privacy and retention

Fabex state is stored per canonical workstream under its plugin data directory with restrictive file permissions. Checkpoints are bounded to eight owner-goal entries, sixteen accepted decisions, one current-status summary, and repository metadata. Terminal operation records are pruned to the most recent 24; unresolved recovery records are preserved. Fabex does not store full Codex transcripts or raw Claude-only Q&A. MCP and host applications may retain their own data independently under their own policies.

## Status and recovery

`/status` reports the canonical mode, route, participants, state health, canonical thread ID, reattach/replacement status, bounded checkpoint counts, repository fingerprints, and unresolved operations. It does not print checkpoint content or transcripts.

`/recover` can inspect, explicitly retry, or abandon a recorded unresolved operation, clear only a confirmed-dead state lock, and commit/discard only an unambiguous validated transaction. State files must never be hand-edited.

## Benchmark status

The repeated paired benchmark is retired as a release blocker. Existing single-run measurements are informational only. A representative earlier implementation task used fewer Claude output tokens than its solo-Claude comparison while reading more cached input; a micro-task cost more because coordination has fixed overhead. Repeated paired runs with predeclared criteria are required before publishing any new quantitative savings claim. Fabex makes no guaranteed savings claim.

## Release activation status

Version 1.3.0 is implemented in this repository. Activation verification is pending until the owner installs or reloads it. Live same-thread mode switching, interruption behavior, exact tool exposure, and cross-restart best-effort reattachment must be tested after that reload; until then 1.3.0 is not described as active or marketplace-ready.

## Platform support

macOS supported; Windows experimental. Platform behavior remains subject to Claude Code and Codex CLI limits.

## Security and contributing

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
