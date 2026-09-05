---
name: askClaude
description: Have Claude alone answer one question read-only without consulting Codex.
---

# Ask Claude

Use the single-use grant supplied by this owner-typed slash command. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once --participants claude --grant <provided-id>` and show the mode message. Without the grant, do not change mode. Apply the configured badge. Claude answers alone without Codex or project effects. Raw Claude-only questions and answers are not relayed to Codex or written into its restart checkpoint. The next prompt restores the prior persistent mode.
