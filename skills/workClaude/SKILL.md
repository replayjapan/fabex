---
name: workClaude
description: Enter normal Claude conversation mode without automatic Codex consultation, while still routing every implementation to Codex.
---

# Work Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants claude` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: workClaude]`; if it is `off`, omit the badge.

Claude answers ordinary questions and decisions without Codex. Raw Claude-only questions and answers are not relayed or stored in Codex's restart checkpoint. For every implementation, invoke `/fabex:jointly`; it switches to `both` and continues the canonical MCP thread. Create `fabex-operational` with the effective `models.operational` value passed explicitly for every GitHub or `gh` sequence. Claude coordinates and verifies; normal-mode main-session Write/Edit/NotebookEdit is mechanically denied. Questions never imply implementation.

Owner approval authorizes the action only and never overrides the prescribed executor. An executor exception is valid only when the owner explicitly names the alternate executor and Fabex records the bounded authorization before use and reconciliation afterward.
