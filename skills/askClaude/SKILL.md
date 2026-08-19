---
name: askClaude
description: Have Claude alone answer one question read-only without consulting Codex.
---

# Ask Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status`. If the route is normal, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once` and show its route message. If already in discussion, stay there. Claude answers alone, without consulting Codex or causing project effects. Briefly note that one-shot mode reverts on the next user prompt.
