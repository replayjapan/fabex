---
name: discussionClaude
description: Enter persistent Claude-only read-only discussion without Codex consultation.
---

# Discussion Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode discussion --participants claude` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: discussionClaude]`; if it is `off`, omit the badge.

Claude discusses read-only without invoking the Codex companion or causing project effects until the user invokes `/workClaude` or `/work`.
