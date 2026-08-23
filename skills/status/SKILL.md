---
name: status
description: Report the canonical Fabex mode label, route, participants, state health, task, partner, and unresolved operations.
---

# Status

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status` and `config` from the resolved workstream root. Lead with `label`, then summarize route, participants, `returnTo`, health, task, partner/controller state, canonical thread ID, turn count, last use, stored/current repository fingerprints, recovery-seed bytes, and queued/active/unresolved operation IDs with genuine lifecycle phase. Apply the configured badge policy. Do not include queued messages, results, checkpoint text, transcripts, environment values, or secrets.
