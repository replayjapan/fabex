# Fabex

Keep the quality of a two-model Fable workflow while Codex carries the coding load.

Fabex is for Fable users who also have Codex access through a ChatGPT plan. It puts both subscriptions to work and treats Claude and Codex as full partners: both receive the owner's visible history and prior converged decisions, both can flag scope problems, and Codex has a permanent watchdog invitation to flag any rule or change that would make it less than a full equal partner. Claude must relay that flag to the owner unedited. Coding is routed to Codex while Claude verifies the result.

### Executor authority

Fabex separates coordination from execution:

- Codex performs every project file edit.
- The bounded `fabex-operational` agent performs every GitHub or `gh` command sequence, including delivery preflight, staging, commit, and push. Its model comes from the effective `models.operational` configuration.
- Claude coordinates and verifies the workflow without performing project edits or operational work directly.

Owner approval authorizes the action only; it never overrides the prescribed executor. An executor exception is valid only when the owner explicitly names the alternate executor. Fabex records a bounded `Executor exception authorized` entry in the persisted checkpoint before use and an `Executor exception reconciled` entry afterward. Emergency or off-books companion recovery follows the same rule. If state is unavailable, the exact authorization and executor remain visible in the transcript and both entries are added immediately after documented recovery restores healthy state. Effects are never inferred during reconciliation.

The `PreToolUse` guard denies protected GitHub commands from the main session and from ambiguous or alternate agent identities. It allows them only when Claude Code supplies both a subagent ID and the exact `fabex-operational` agent type. A textual marker cannot bypass the guard.

Pick the mode that fits the moment:

- `work`: the flagship mode, with both AIs working together.
- `workClaude`: normal conversation without copying Codex on everything; Codex still does all coding.
- `discussion`: both AIs talk, and nothing executes.
- `discussionClaude` / `discussionCodex`: read-only discussion with one AI.
- `ask`: one joint question.
- `askClaude` / `askCodex`: one question for one AI, without it spinning into implementation.

Mode labels and an optional status-line badge make it clear where you are. Some behavior is mechanically enforced and some is advisory; see [Enforced and advisory behavior](#enforced-and-advisory-behavior).

## How it works

```text
request
├─ clear-criteria/mechanical implementation → Codex implements → Claude verifies
└─ design/judgment → current-turn opinion-blind views → honest convergence
                                                    └─ if code: Codex implements → Claude verifies
```

Fabex has two routing policies:

- **Implement:** The default for builds, fixes, changes, and implementations with explicit acceptance criteria, plus mechanical fixes. Claude states one short task-and-criteria framing line, delegates the owner's verbatim request to Codex's persistent write sibling, then independently runs the stated tests or criteria.
- **Decide:** For conversation, architecture, design, tradeoffs, and other judgments. Claude and Codex are current-turn opinion-blind: they share owner-visible history and prior decisions, but neither receives the other's current unpublished opinion. They then converge honestly.

The Decide lane remains auditable: Codex is asked before Claude publishes its current view; Claude publishes its complete view before fetching; only then does Fabex fetch, verify the returned thread ID, and converge. Neither participant receives the other's current unpublished opinion. Every Codex task handoff carries the owner's words verbatim, explicitly invites scope-mismatch and partnership-parity flags before execution, and requires Claude to relay any flag unedited.

### Continuous Codex memory

Each resolved project workstream persists a primary read-only conversation thread, a write-thread sibling, a bounded checkpoint (verbatim owner goals, accepted decisions, and current status), and metadata for turn count, last use, re-sync state, and repository branch/HEAD/dirty fingerprint. Every both-participant owner message reaches the primary thread, including greetings and lookups. The owner-selected Claude-only modes are the only exclusion.

Before using `--resume-last`, Fabex reads the companion's current resumable task candidate and requires its thread ID to match the recorded primary or write sibling. An absent or mismatched candidate authorizes one visible checkpoint-seeded fresh replacement before any owner prompt is launched; ambiguous inspection failures remain fail-closed. Fabex still mechanically checks the returned ID before exposing the result. Calls are serialized per workstream, and bounded outcomes are persisted for the next sibling consult.

Companion resume is Claude-session scoped. At a real SessionStart in a mode that includes Codex, an existing primary thread is re-synced immediately from its persisted checkpoint through the tracked background store, the new ID is recorded, and status labels it `re-synced`; a failed or ambiguous re-sync remains fail-closed. Claude-only mode keeps companion denial intact and leaves the seeded re-sync pending until Codex is selected. Unseeded new threads remain limited to the initial thread and read-only-to-write boundary; candidate-driven replacements are always checkpoint-seeded and reported. There is no public fresh-thread command.

Repository-dependent prompts warn that previous file observations may be stale. Status exposes thread metadata and recommends offering checkpoint-and-refresh when a thread is long or the repository fingerprint moved substantially. Refresh is never silent.

## Enforced and advisory behavior

| Mechanically enforced | Advisory (best-effort instructions, auditable in the transcript but not guaranteed) |
| --- | --- |
| Read-only blocking in discussion and ask-once modes | Question discipline |
| Validated controls only in discussion and ask-once modes | Jointly invocation and lane selection |
| Fail-closed routing when state is unhealthy | Codex-only edits in normal mode |
| Ask-once restoration after the next user prompt | Current-turn opinion-blind ordering |
| Codex companion denial while participants are `claude` | Participant behavior beyond that companion denial |
| Main-session and ambiguous-executor denial for GitHub pushes and `gh` commands | Executor assignment for operational actions that the push guard does not classify |
| Serialized thread begin/complete operations and resumed-thread ID verification | Forwarding every owner message and bounded checkpoint content |
| Schema migration and checkpoint-seeded re-sync state | Verbatim relay of Codex scope and partnership-parity flags |
| Deterministic, read-only status-line rendering | Reply labels and badges |
|  | Operational cheaper-model selection |

Advisory compliance varies with the model and context.

## Requirements

- Claude Code
- Codex CLI and the official Codex companion plugin
- Node.js 20 or newer

## Setting up Codex

Install the Codex CLI with any one of these official options:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
# or, with npm
npm install -g @openai/codex
# or, with Homebrew
brew install --cask codex
```

Sign in with your ChatGPT account, then add OpenAI's Codex companion for Claude Code:

```sh
codex login
claude plugin marketplace add openai/codex-plugin-cc
claude plugin install codex@openai-codex
```

In Claude Code, run `/fabex:diagnose` and confirm that it reports the companion as available.

**FAQ:** Already run the Codex MCP server? Keep it—both use the same account and do not conflict. Fabex uses the companion plugin; avoid running write tasks through both at the same time.

## Install

```sh
claude plugin marketplace add <repo-or-path>
claude plugin install fabex@fabex
```

## Try it

- `/jointly` runs the two-lane protocol explicitly.
- `/ask` asks both AIs once in read-only mode.
- `/askClaude` or `/askCodex` selects one AI for a read-only answer.
- `/discussion` enters persistent joint read-only discussion.
- `/discussionClaude` and `/discussionCodex` select a single participant; the Codex variant relays the workstream's continuous primary Codex thread.
- `/work` returns to joint normal work; `/workClaude` returns to normal Claude conversation without automatic Codex consultation.
- `/status` and `/diagnose` report routing and health.

Normal mode is the default. With both participants selected, clear implementation requests use Implement and every other owner turn uses the continuous primary conversation thread. Both means both every time; select a single-AI mode when only one participant is wanted.

### Modes and labels

Route and participants are stored separately, while every supported combination has one canonical display label:

| Skill | Route | Participants | Label | Effects |
| --- | --- | --- | --- | --- |
| `/work` | normal | both | `work` | Normal permissions; joint routing |
| `/workClaude` | normal | claude | `workClaude` | Normal permissions; no automatic Codex consultation for questions |
| `/discussion` | discussion | both | `discussion` | Persistent read-only; both AIs |
| `/discussionClaude` | discussion | claude | `discussionClaude` | Persistent read-only; Claude only |
| `/discussionCodex` | discussion | codex | `discussionCodex` | Persistent read-only; attributed Codex relay |
| `/ask` | ask-once | both | `ask` | One read-only joint answer, then restore |
| `/askClaude` | ask-once | claude | `askClaude` | One read-only Claude answer, then restore |
| `/askCodex` | ask-once | codex | `askCodex` | One read-only Codex answer, then restore |

Codex always performs implementation. In `workClaude`, a build, fix, change, create, update, or implement request still invokes `/jointly`, explicitly switches participants to `both`, and routes edits to the persistent write sibling.

### Workstream-root resolution

Controls and hooks walk upward from the supplied working directory to the nearest ancestor that already owns Fabex state, just as repository tools locate an enclosing root. This prevents a shell `cd` into a subdirectory from silently creating or operating on another state root. If no ancestor has Fabex state, the invoked working directory becomes a new workstream root.

## Configuration

No configuration is required. The main Claude model is always the user's `/model` choice.

Fabex exposes two Codex dials, one operational-agent model, and a reply-label setting:

- `models.codex.model`: Codex model token, or `null` to let the companion choose.
- `models.codex.reasoningEffort`: reasoning-effort token.
- `models.operational`: Claude model used for bounded image, GitHub, and log chores.
- `display.replyModeBadge`: `always`, `changes`, or `off`; defaults to `always`.

Configuration merges field by field in this order:

1. shipped `config/defaults.json`;
2. machine `config.json` under `FABEX_HOME`, or the standard Fabex plugin data directory;
3. project `.fabex/config.json`.

Copy and adjust this JSON at either override location:

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

Unknown reasoning-effort tokens pass through with a warning so newer companion values do not break older Fabex releases. Run `/status`, then the Fabex `config` control described by `/diagnose`, to inspect effective values, sources, and warnings.

### Optional status line

Fabex ships `scripts/status-line.mjs`, a strictly read-only renderer for Claude Code's status-line JSON input. It canonicalizes the supplied working directory, honors `FABEX_HOME`, and prints labels such as `Fabex: discussionCodex · read-only`. Missing, locked, unsettled, or invalid state prints `Fabex: state?`; it never guesses `work`.

Installation is opt-in. First inspect your user or project Claude settings and do not overwrite an existing `statusLine`. Copy `scripts/status-line.mjs` and its `scripts/lib/mode.mjs` dependency into a stable directory that preserves that layout. Do not reference a plugin-cache path, because updates can replace it. Then merge a command like this into the appropriate settings file, substituting your stable path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$HOME/.local/share/fabex-status-line/scripts/status-line.mjs\""
  }
}
```

Fabex does not set `refreshInterval` by default.

## Token economics

Three claims should be kept separate:

1. Reducing Claude-side usage on substantial implementation work and operational chores is the design goal, not a guaranteed result. The Implement lane moves coding and edit-test-fix loops to Codex while keeping Claude's role to a short framing line and independent verification.
2. Every both-mode message now consults Codex by owner requirement. This intentionally adds latency and Codex usage, including for greetings and lookups. Choose a Claude-only or Codex-only mode when one participant is desired.
3. Codex-side usage is real and should be reported separately. Combined economics depend on task shape, models, caching, and prices; treat totals only as estimates, not guaranteed savings.

A representative implementation benchmark used the same six-bug, three-file, 12-test task, identical pass criteria, and a fresh copy for each run. All three runs passed:

| Flow | Claude output tokens | Turns | Claude cache-read tokens |
| --- | ---: | ---: | ---: |
| Solo Claude | 3,919 | 12 | 145k |
| Fabex duplicated-analysis design (superseded) | 6,816 | 15 | 323k |
| Fabex final two-lane design with imperative delegation wording | 2,224 | 9 | 255k |

On this representative implementation task, the final design used about 43% fewer Claude output tokens than solo Claude, and delegation to write-enabled Codex was confirmed. The superseded design forced Claude to duplicate implementation analysis before Codex did the work; the final Implement lane removes that duplication, while Decide preserves current-turn opinion-blind views where judgment benefits from them. These are single-run measurements, not a general savings guarantee. Fabex also read more cached input than solo Claude (255k versus 145k); cache reads are the cheapest Claude token class, but they are still usage. Codex-side usage is separate real spend and is not included in the Claude figures above.

A paired one-line micro-task showed the same overhead pattern: Fabex used 3,078 Claude output tokens and 322k cache-read tokens over 12 turns; solo Claude used 1,397 output tokens and 184k cache-read tokens over eight turns. Both produced identical code and passed. Quick tasks can still cost more because delegation and verification have fixed overhead; use `/askClaude` or a plain request when token cost matters more than collaboration.

The release-blocking efficiency gate remains the median of repeated paired Fabex-versus-solo runs on a representative multi-file implementation task, with a predeclared savings margin. Micro-task pairs remain useful baseline data, but are informational only and cannot pass or fail the release gate.

## Platform support

macOS supported; Windows experimental (design targets Windows, verification in progress).

## Updating

```sh
claude plugin update fabex@fabex
```

Then run `/reload-plugins` in Claude Code.

## Security and contributing

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.
