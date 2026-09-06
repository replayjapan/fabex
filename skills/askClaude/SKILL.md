---
name: askClaude
description: Have Claude alone answer one question read-only without consulting Codex.
---

# Ask Claude

`UserPromptExpansion` captures any trailing question byte-for-byte in private grant state without template interpolation. Use the supplied grant with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once --participants claude --grant <provided-id>`. The command consumes it only after success; with text it prints `OWNER MESSAGE (verbatim)` after ask-once is active, and only then may Claude answer it. If an older Codex operation is active, wait for the named operation to stop and rerun the exact command; expiry stays paused. With no text it changes mode only. Without the grant, do not change mode. Apply the configured badge. Claude answers alone without Codex or project effects. Raw Claude-only questions and answers are not relayed to Codex or written into its restart checkpoint. The next prompt restores the prior persistent mode.
