---
name: diagnose
description: Diagnose Fabex activation, state health, platform facts, hooks, and Codex SDK installation.
---

# Diagnose

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs diagnose` from the project root. Report the factual activation block: source and registry versions, match, hook validity, reload requirement or unknown, last recorded turn/version, and verdict. Also report state health, safe lock metadata, SDK installation, repository root, network switch, and broad command warnings. After updating to 1.5.1, diagnose must precede the first Codex task. Never claim activation when the verdict is unknown or unverified.
