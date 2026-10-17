---
name: status
description: Report the canonical Fabex mode label, route, participants, state health, task, partner, and unresolved operations.
---

# Status

Owner-facing reply: show each participant's own short conclusion under its model-aware label, then Decided. Paste Codex's ownerSummary and label unchanged. Omit resolved disagreements and routine uncertainty; show an open issue only when it affects an owner decision, blocks progress or materially limits the result. Action required appears only when the owner must act. Omit empty sections and absent partners. Keep the complete phase records available through result and relay --full. Wait in bounded slices; a timeout does not complete the task.

Report indexed attachment states (`selected`, `submitted`, `delivered`, `failed`) when present. `selected` is queue acceptance, not receipt; `delivered` requires a completed image-bearing SDK turn and does not prove visual accuracy. Null means historical delivery is unknown. Do not dump upload paths. A phone photo without an attachment record is not a successful forwarding test.


Use `speakers.labels` for attribution: family-only `Claude (Fable):` / `Codex (Astra):` when known, plain `Claude:` / `Codex:` otherwise. Report configured model source honestly, not as served-model verification. Include available bounded operation usage counts without treating them as billing. `controller wait` retries both lock contention and deferred migration within its timeout; Monitor and TaskOutput remain usable during deferral.

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status` and `config` from the resolved workstream root. Use `status --brief` for summary-only output or `status --all` only when full retained history is needed. Lead with `label`, then summarize route, participants, health, task, partner/controller state, canonical thread, checkpoint time/warnings, separately timestamped captured/live fingerprints, and relevant operations. Do not include queued messages, results, checkpoint text, transcripts, environment values, or secrets.


## Message and attachment handling

Use `controller.mjs relay --operation-id <uuid>` to obtain only the exact relayBlock, and paste it unmodified. Ordinary both-participant image-only requests use `ownerMessage: ""` with attachments; mode uploads use repeated `--attach` arguments before grant consumption. Prefer `previousReplyStatus: "recorded"`; unavailable evidence must be reported, not invented or truncated. Discussion/Ask writes must stay within the effective activity policy: validated research locations and text plans when permitted, or external scratch/memory roots. Application edits remain denied. Image restrictions remain in unhealthy states. Report attachment delivery from recorded status; do not infer successful forwarding from a valid path alone.

Paste the generated relay block without routine JSON metadata; use internal structured result fields only when needed for verification.
