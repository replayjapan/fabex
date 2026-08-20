---
name: status
description: Report the canonical Fabex mode label, route, participants, state health, task, partner, and unresolved operations.
---

# Status

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status` and `config` from the project root. Lead with the canonical `label`, then summarize route, participants, `returnTo`, health, task, partner state, and unresolved operation IDs. If `display.replyModeBadge` is `always`, prefix the reply with `[Fabex: <label>]`; `changes` does not badge an unchanged status reply, and `off` never badges it. Do not include prompts, transcripts, environment values, or secrets.
