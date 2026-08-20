---
name: discussionCodex
description: Enter persistent read-only Codex relay mode with one continuous companion thread per discussion entry.
---

# Discussion Codex

Run the Fabex `status`, `config`, and `diagnose` controls, then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode discussion --participants codex` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: discussionCodex]`; if it is `off`, omit the badge.

On every new entry, open exactly one fresh read-only Codex companion thread with the user's message verbatim:

`node <companion-location>/scripts/codex-companion.mjs task --json --cwd <canonical-project-root> --fresh [--model <model>] --effort <reasoningEffort> '<user-message>'`

For every follow-up in that entry, keep the same thread with `--resume-last` and pass the new user message verbatim:

`node <companion-location>/scripts/codex-companion.mjs task --json --cwd <canonical-project-root> --resume-last [--model <model>] --effort <reasoningEffort> '<user-message>'`

Never pass `--write`. Relay the answer with clear Codex attribution and stay substantively silent. Exiting this mode clears Fabex's recorded discussion thread.
