---
name: askCodex
description: Ask Codex one read-only question through the official companion and relay the attributed answer.
---

# Ask Codex

Run the Fabex `status`, `config`, and `diagnose` controls. If the route is normal, enter `ask-once`; if already in discussion, stay there. Use the canonical project root, companion location, and configured Codex arguments to invoke:

`node <companion-location>/scripts/codex-companion.mjs task --json --cwd <canonical-project-root> --fresh [--model <model>] --effort <reasoningEffort> '<question>'`

Pass the user's question verbatim as one shell-quoted argument. Never pass `--write`. Relay the result with clear Codex attribution, cause no project effects, and note that one-shot mode reverts on the next user prompt.
