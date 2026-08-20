# Fabex

Keep the quality of a Claude-led Fable workflow while Codex carries the coding load.

Fabex is for Fable users who also have Codex access through a ChatGPT plan. It puts both your subscriptions to work and reduces pressure on your Claude limits during heavy coding. It is designed to route coding to Codex while Claude leads the workflow.

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
└─ design/judgment → blind Claude + Codex views → honest convergence
                                                    └─ if code: Codex implements → Claude verifies
```

Fabex has two routing policies:

- **Implement:** The default for builds, fixes, changes, and implementations with explicit acceptance criteria, plus mechanical fixes. Claude states one short task-and-criteria framing line, immediately delegates the user's request to a fresh write-enabled Codex task, then independently runs the stated tests or criteria. Claude does not duplicate Codex's bug-by-bug implementation analysis.
- **Decide:** For architecture, design, tradeoffs, and other substantive judgments. Claude and Codex form blind independent views and converge honestly. If code follows, their views stay focused on the approach and the work moves to Implement.

The Decide lane remains auditable in the conversation: Claude states its complete view before fetching Codex's result. Codex receives the user's message plus neutral context, never Claude's draft opinion. In both lanes, Codex performs all file edits and returns a bounded summary of files changed, diffstat, test exit codes, unresolved risks, and decisions needed; Claude verifies rather than relaying full transcripts.

## Enforced and advisory behavior

| Mechanically enforced | Advisory (best-effort instructions, auditable in the transcript but not guaranteed) |
| --- | --- |
| Read-only blocking in discussion and ask-once modes | Question discipline |
| Validated controls only in discussion and ask-once modes | Jointly invocation and lane selection |
| Fail-closed routing when state is unhealthy | Codex-only edits in normal mode |
| Ask-once restoration after the next user prompt | Independent verification and blindness ordering |
| Codex companion denial while participants are `claude` | Participant behavior beyond that companion denial |
| Deterministic, read-only status-line rendering | Reply labels and badges |
|  | Operational delegation and cheaper-model selection |

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
- `/discussionClaude` and `/discussionCodex` select a single participant; the Codex variant relays one continuous Codex thread per entry.
- `/work` returns to joint normal work; `/workClaude` returns to normal Claude conversation without automatic Codex consultation.
- `/status` and `/diagnose` report routing and health.

Normal mode is the default. With joint-by-default enabled, clear implementation requests use Implement, substantive judgments use Decide, and greetings and trivial lookups skip the protocol.

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

Codex always performs implementation. In `workClaude`, a build, fix, change, create, update, or implement request still invokes `/jointly`, explicitly switches participants to `both`, and routes edits to a write-enabled Codex task.

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
2. The Decide lane intentionally spends extra tokens on independent views when judgment is valuable. If you mostly chat, set `collaboration.jointByDefault` to `false` and invoke `/jointly` only when useful.
3. Codex-side usage is real and should be reported separately. Combined economics depend on task shape, models, caching, and prices; treat totals only as estimates, not guaranteed savings.

A representative implementation benchmark used the same six-bug, three-file, 12-test task, identical pass criteria, and a fresh copy for each run. All three runs passed:

| Flow | Claude output tokens | Turns | Claude cache-read tokens |
| --- | ---: | ---: | ---: |
| Solo Claude | 3,919 | 12 | 145k |
| Fabex duplicated-analysis design (superseded) | 6,816 | 15 | 323k |
| Fabex final two-lane design with imperative delegation wording | 2,224 | 9 | 255k |

On this representative implementation task, the final design used about 43% fewer Claude output tokens than solo Claude, and delegation to write-enabled Codex was confirmed. The superseded design forced Claude to duplicate implementation analysis before Codex did the work; the final Implement lane removes that duplication, while Decide preserves blind views where judgment benefits from them. These are single-run measurements, not a general savings guarantee. Fabex also read more cached input than solo Claude (255k versus 145k); cache reads are the cheapest Claude token class, but they are still usage. Codex-side usage is separate real spend and is not included in the Claude figures above.

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
