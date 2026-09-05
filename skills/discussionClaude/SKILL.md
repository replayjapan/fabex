---
name: discussionClaude
description: Enter persistent Claude-only read-only discussion without Codex consultation.
---

# Discussion Claude

Use the single-use grant supplied by this owner-typed slash command. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode discussion --participants claude --grant <provided-id>` from the project root and show the mode message. Without the grant, do not change mode. Apply the configured badge.

Claude discusses read-only without submitting a Codex SDK turn or causing project effects until `/workClaude` or `/work`. Raw Claude-only questions and answers are not relayed or stored in the structured checkpoint; owner-approved decisions and relevant bounded status may be recorded explicitly.
