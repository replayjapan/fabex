# Fabex

Fabex uses independent Claude and Codex views where judgment matters, converges honestly, and gives implementation to Codex without duplicating mechanical analysis.

Built for Fable, works with every Claude model.

## How it works

```text
request
├─ clear-criteria/mechanical implementation → Codex implements → Claude verifies
└─ design/judgment → blind Claude + Codex views → honest convergence
                                                    └─ if code: Codex implements → Claude verifies
```

Fabex has two deterministic lanes:

- **Implement:** The default for builds, fixes, changes, and implementations with explicit acceptance criteria, plus mechanical fixes. Claude states one short task-and-criteria framing line, immediately delegates the user's request to a fresh write-enabled Codex task, then independently runs the stated tests or criteria. Claude does not duplicate Codex's bug-by-bug implementation analysis.
- **Decide:** For architecture, design, tradeoffs, and other substantive judgments. Claude and Codex form blind independent views and converge honestly. If code follows, their views stay focused on the approach and the work moves to Implement.

The Decide lane remains auditable in the conversation: Claude states its complete view before fetching Codex's result. Codex receives the user's message plus neutral context, never Claude's draft opinion. In both lanes, Codex performs all file edits and returns a bounded summary of files changed, diffstat, test exit codes, unresolved risks, and decisions needed; Claude verifies rather than relaying full transcripts.

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
- `/ask` answers once in read-only mode.
- `/askClaude` or `/askCodex` selects one AI for a read-only answer.
- `/discussion` enters persistent read-only discussion.
- `/work` returns to normal work.
- `/status` and `/diagnose` report routing and health.

Normal mode is the default. With joint-by-default enabled, clear implementation requests use Implement, substantive judgments use Decide, and greetings and trivial lookups skip the protocol.

## Configuration

No configuration is required. The main Claude model is always the user's `/model` choice.

Fabex exposes two Codex dials and one operational-agent model:

- `models.codex.model`: Codex model token, or `null` to let the companion choose.
- `models.codex.reasoningEffort`: reasoning-effort token.
- `models.operational`: Claude model used for bounded image, GitHub, and log chores.

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
  }
}
```

Unknown reasoning-effort tokens pass through with a warning so newer companion values do not break older Fabex releases. Run `/status`, then the Fabex `config` control described by `/diagnose`, to inspect effective values, sources, and warnings.

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
| Fabex final two-lane design with enforced delegation wording | 2,224 | 9 | 255k |

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
