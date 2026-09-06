---
name: status
description: Report the canonical Fabex mode label, route, participants, state health, task, partner, and unresolved operations.
---

# Status

For 1.7.0 report `reviewStructured`, `relayStatus`, and `resultWarning` metadata when present, without dumping answer text or attachment paths. Retrieve each operation's `relayBlock` through controller result when replying to that owner cycle. Complete labeled Codex quotes precede Fable's view; do not replace them with a status summary.

Use `speakers.labels` for attribution: family-only `Claude (Fable):` / `Codex (Astra):` when known, plain `Claude:` / `Codex:` otherwise. Report configured model source honestly, not as served-model verification. Include available bounded operation usage counts without treating them as billing. `controller wait` retries both lock contention and deferred migration within its timeout; Monitor and TaskOutput remain usable during deferral.

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status` and `config` from the resolved workstream root. Use `status --brief` for summary-only output or `status --all` only when full retained history is needed. Lead with `label`, then summarize route, participants, health, task, partner/controller state, canonical thread, checkpoint time/warnings, separately timestamped captured/live fingerprints, and relevant operations. Do not include queued messages, results, checkpoint text, transcripts, environment values, or secrets.
