---
name: diagnose
description: Diagnose Fabex activation, state health, platform facts, hooks, and Codex MCP configuration.
---

# Diagnose

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs diagnose` from the project root. Report plugin and Node versions, loaded path when available, platform support, hook validity, route/state health, transaction status, MCP configuration, and whether both exact tools are exposed. After updating to 1.3.0, diagnose must precede the first Codex task. Do not claim activation or continuity that was not tested.
