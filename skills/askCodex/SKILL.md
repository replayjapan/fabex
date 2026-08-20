---
name: askCodex
description: Ask Codex one read-only question through the official companion and relay the attributed answer.
---

# Ask Codex

Run the Fabex `status`, `config`, and `diagnose` controls, then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once --participants codex` and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix the answer with `[Fabex: askCodex]`; if it is `off`, omit the badge. Use the canonical project root, companion location, and configured Codex arguments to invoke:

`node <companion-location>/scripts/codex-companion.mjs task --json --cwd <canonical-project-root> --fresh [--model <model>] --effort <reasoningEffort> '<question>'`

Pass the user's question verbatim as one shell-quoted argument. Never pass `--write`. Relay the result with clear Codex attribution, stay substantively silent, cause no project effects, and note that the next user prompt restores the prior persistent mode.
