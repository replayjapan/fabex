---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: work]`; if it is `off`, omit the badge. This changes only Fabex routing; it does not widen native permissions or sandbox access.
