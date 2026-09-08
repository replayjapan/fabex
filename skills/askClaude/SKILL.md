---
name: askClaude
description: Have Claude alone answer one question read-only without consulting Codex.
---

# Ask Claude

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

`UserPromptExpansion` captures any trailing question byte-for-byte in private grant state without template interpolation. Use the supplied grant with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode ask-once --participants claude --grant <provided-id>`. The command consumes it only after success; with text it prints `OWNER MESSAGE (verbatim)` after ask-once is active, and only then may Claude answer it. If an older Codex operation is active, wait for the named operation to stop and rerun the exact command; expiry stays paused. With no text it changes mode only. Without the grant, do not change mode. Apply the configured badge. Claude answers alone without Codex or project effects. Raw Claude-only questions and answers are not relayed to Codex or written into its restart checkpoint. The next prompt restores the prior persistent mode.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for the completed owner-facing summary.

Run the mode command standalone: no `cd` prefix, `&&` chain, trailing command, or pipe. Paste the generated relay block unchanged: Codex-authored summary or visible full-answer fallback plus non-empty flags, never internal JSON metadata. Claude-only modes still do not invoke Codex.
