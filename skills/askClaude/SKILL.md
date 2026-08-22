---
name: askClaude
description: Have Claude alone answer one question read-only without consulting Codex.
---

# Ask Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once --participants claude` and show the mode message. Apply the configured badge. Claude answers alone without Codex or project effects. Raw Claude-only questions and answers are not relayed to Codex or written into its restart checkpoint. The next prompt restores the prior persistent mode.
