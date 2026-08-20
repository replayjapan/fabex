---
name: workClaude
description: Enter normal Claude conversation mode without automatic Codex consultation, while still routing every implementation to Codex.
---

# Work Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants claude` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: workClaude]`; if it is `off`, omit the badge.

In this mode, Claude answers ordinary questions and decisions without automatically consulting Codex. Codex always does the coding: for every build, fix, change, create, update, or implement request, invoke `/fabex:jointly`; that explicit joint action switches participants to `both` before launching the write-enabled Codex task. Claude never edits files. Questions authorize answers only and never imply implementation. Native permissions and sandbox access remain unchanged.
