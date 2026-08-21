---
name: workClaude
description: Enter normal Claude conversation mode without automatic Codex consultation, while still routing every implementation to Codex.
---

# Work Claude

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants claude` from the project root and show the mode message. If `display.replyModeBadge` is `always` or `changes`, prefix this transition reply with `[Fabex: workClaude]`; if it is `off`, omit the badge.

In this mode, Claude answers ordinary questions and decisions without automatically consulting Codex. Codex always does the coding and performs every project file edit: for every build, fix, change, create, update, or implement request, invoke `/fabex:jointly`; that explicit joint action switches participants to `both` before launching the write-enabled Codex task. The bounded `fabex-operational` agent, using the effective `models.operational` configuration, performs every GitHub or `gh` sequence including delivery preflight, staging, commit, and push. Claude coordinates and verifies; Claude never performs either class of work directly. Questions authorize answers only and never imply implementation. Native permissions and sandbox access remain unchanged.

Owner approval authorizes the action only and never overrides the prescribed executor. An executor exception is valid only when the owner explicitly names the alternate executor and Fabex records the bounded authorization before use and reconciliation afterward.
