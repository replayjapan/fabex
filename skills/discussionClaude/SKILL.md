---
name: discussionClaude
description: Enter persistent Claude-only read-only discussion without Codex consultation.
---

# Discussion Claude

`UserPromptExpansion` captures trailing command text byte-for-byte in private grant state without template interpolation. Use the supplied single-use grant with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode discussion --participants claude --grant <provided-id>` from the project root. The command consumes it only after success; with text it prints `OWNER MESSAGE (verbatim)` after the read-only mode is active, and only then may Claude answer it. If an older Codex operation is active, wait for the named operation to stop and rerun the exact command; expiry stays paused. With no text it changes mode only. Without the grant, do not change mode. Show the mode message and configured badge.

Claude discusses read-only without submitting a Codex SDK turn or causing project effects until `/workClaude` or `/work`. Raw Claude-only questions and answers are not relayed or stored in the structured checkpoint; owner-approved decisions and relevant bounded status may be recorded explicitly.
