---
name: status
description: Report the canonical Fabex mode label, route, participants, state health, task, partner, and unresolved operations.
---

# Status

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

Report indexed attachment states (`selected`, `submitted`, `delivered`, `failed`) when present. `selected` is queue acceptance, not receipt; `delivered` requires a completed image-bearing SDK turn and does not prove visual accuracy. Null means historical delivery is unknown. Do not dump upload paths. A phone photo without an attachment record is not a successful forwarding test.

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

Use `speakers.labels` for attribution: family-only `Claude (Fable):` / `Codex (Astra):` when known, plain `Claude:` / `Codex:` otherwise. Report configured model source honestly, not as served-model verification. Include available bounded operation usage counts without treating them as billing. `controller wait` retries both lock contention and deferred migration within its timeout; Monitor and TaskOutput remain usable during deferral.

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs status` and `config` from the resolved workstream root. Use `status --brief` for summary-only output or `status --all` only when full retained history is needed. Lead with `label`, then summarize route, participants, health, task, partner/controller state, canonical thread, checkpoint time/warnings, separately timestamped captured/live fingerprints, and relevant operations. Do not include queued messages, results, checkpoint text, transcripts, environment values, or secrets.


## 1.8.0 reliability workflow

Use `controller.mjs relay --operation-id <uuid>` to obtain only the exact relayBlock, and paste it unmodified. Ordinary both-participant image-only requests use `ownerMessage: ""` with attachments; mode uploads use repeated `--attach` arguments before grant consumption. Prefer `previousReplyStatus: "recorded"`; unavailable evidence must be reported, not invented or truncated. Healthy discussion/ask allow only validated external scratch/memory writes, never project writes. Image restrictions remain in unhealthy states. Follow `docs/acceptance-1.8.0.md`; automated tests do not establish live phone or resource behavior.

Paste the generated relay block without routine JSON metadata; use internal structured result fields only when needed for verification.
