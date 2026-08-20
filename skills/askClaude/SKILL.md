---
name: askClaude
description: Have Claude alone answer one question read-only without consulting Codex.
---

# Ask Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once --participants claude` and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix the answer with `[Fabex: askClaude]`; if it is `off`, omit the badge. Claude answers alone, without consulting Codex or causing project effects. Briefly note that the next user prompt restores the prior persistent mode.
