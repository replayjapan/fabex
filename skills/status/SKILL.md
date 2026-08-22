---
name: status
description: Report the canonical Fabex mode label, route, participants, state health, task, partner, and unresolved operations.
---

# Status

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status` and `config` from the resolved workstream root. Lead with `label`, then summarize route, participants, `returnTo`, health, task, partner state, canonical thread ID, turn count, last use, reattach/replacement status, stored/current repository fingerprints, and unresolved operation IDs. Apply the configured badge policy. Do not include prompts, checkpoint text, transcripts, environment values, or secrets.
