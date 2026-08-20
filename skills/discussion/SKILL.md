---
name: discussion
description: Enter persistent joint read-only discussion with Claude and Codex until the user invokes work.
---

# Discussion

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode discussion --participants both` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: discussion]`; if it is `off`, omit the badge.

Remain read-only until the user invokes `/work`. For every substantive discussion message, consult Codex through the validated read-only companion grammar with the user's message verbatim before answering, then present Claude's view and an honest convergence. Never pass `--write` or cause other project effects.
