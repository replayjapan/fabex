---
name: diagnose
description: Diagnose Fabex activation, state health, platform facts, hooks, and Codex SDK installation.
---

# Diagnose

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs diagnose` from the project root. Report plugin and Node versions, Beta status, loaded path, platform support, hook validity, route/state health, transaction status, declared SDK version, dependency installation, subscription-auth assumption, and pending activation criteria. After updating to 1.4.0, diagnose must precede the first Codex task. Do not claim activation or continuity that was not live-tested.
