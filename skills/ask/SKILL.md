---
name: ask
description: Have Claude and Codex answer one question jointly and read-only, then restore the prior persistent mode.
---

# Ask

Run the Fabex `status`, `config`, and `diagnose` controls, then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once --participants both` and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix the answer with `[Fabex: ask]`; if it is `off`, omit the badge.

Before forming Claude's answer, launch a fresh validated read-only Codex companion task with the user's question verbatim. Never pass `--write`. Form Claude's independent view, fetch Codex's result, attribute both where useful, and converge honestly without project effects. Note briefly that the next user prompt restores the prior persistent mode.
