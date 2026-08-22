---
name: discussionClaude
description: Enter persistent Claude-only read-only discussion without Codex consultation.
---

# Discussion Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode discussion --participants claude` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: discussionClaude]`; if it is `off`, omit the badge.

Claude discusses read-only without invoking Codex MCP or causing project effects until `/workClaude` or `/work`. Raw Claude-only questions and answers are not relayed to Codex or stored in its restart checkpoint; owner-approved decisions and relevant bounded status may be recorded explicitly.
