---
name: status
description: Report the canonical Fabex mode label, route, participants, state health, task, partner, and unresolved operations.
---

# Status

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status` and `config` from the resolved workstream root. Lead with the canonical `label`, then summarize route, participants, `returnTo`, health, task, partner state, primary/write thread IDs, turn count, last use, re-sync label, stored and current repository fingerprints, checkpoint-and-refresh recommendation, and unresolved operation IDs. If refresh is recommended, offer checkpoint-and-refresh to the owner; never reset silently. Apply the configured badge policy. Do not include prompts, checkpoint text, transcripts, environment values, or secrets.
