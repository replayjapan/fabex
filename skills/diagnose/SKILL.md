---
name: diagnose
description: Diagnose Fabex activation, state health, platform facts, hooks, and Codex SDK installation.
---

# Diagnose

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs diagnose` from the project root. Report source and installed-registry versions, whether they match, loaded path, Beta status, platform support, hook validity, route/state health, transaction status, SDK version, dependency installation, effective repository root and network switch, subscription-auth assumption, and pending activation criteria. After updating to 1.5.0, diagnose must precede the first Codex task. Do not claim activation or continuity that was not live-tested.
