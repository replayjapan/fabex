---
name: ask
description: Answer one question read-only, then return to normal mode on the next user prompt.
---

# Ask

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status`. If the route is normal, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once` and show its route message. If already in discussion, stay there. Answer without file changes, effectful commands, or other project effects. Briefly note that one-shot mode reverts on the next user prompt.
