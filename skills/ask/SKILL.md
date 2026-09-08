---
name: ask
description: Have Claude and Codex answer one question jointly through the canonical Codex SDK thread with a read-only sandbox.
---

# Ask

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

For phone photos, forward the host-supplied upload file reference for this owner message in Phase 1 `attachments`, without opening or describing it. Preserve ownerMessage verbatim; do not append the host note. The controller requires the hook-recorded upload session and limits each image to 16 MiB. Do not scan or guess upload files. Follow jointly's selected/submitted/delivered/failed reporting; a validation error must never become a silent text-only retry. If mode-created Phase 1 already omitted the file, report the gap.

Codex is the default image reviewer. Fable uses Codex's description and must not open the images. When needed, use the configured lower-model operational helper and exact image-description envelope documented in jointly. Read-only research is permitted; do not change mode to obtain tools. An owner `attach: /absolute/image.png` line in the mode-command text explicitly selects an attachment without changing that text.

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

`UserPromptExpansion` captures any trailing question byte-for-byte in private grant state; Fabex does not interpolate it into this template. Use the supplied single-use grant with `control.mjs mode ask-once --participants both --grant <provided-id>` and show the mode message. With no trailing text it changes mode only. With text the atomic command prints a read-only Phase 1 operation ID: wait, read the result and retained owner message, then submit Phase 2. The grant is consumed only after success. Without it, do not change mode. Apply the configured reply badge.

Follow the jointly skill's SDK submit/status/result protocol with the owner's question verbatim and parity watchdog. The controller resumes the canonical thread with `read-only`, verifies the exact `thread.started` ID, and queues behind active work when necessary. Attribute both conclusions, relay flags unedited, and converge. The next owner prompt restores the prior mode.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for the completed owner-facing summary.

Run the mode command standalone: no `cd` prefix, `&&` chain, trailing command, or pipe. Paste the generated relay block unchanged: Codex-authored summary or visible full-answer fallback plus non-empty flags, never internal JSON metadata. Claude-only modes still do not invoke Codex.

## 1.9.0 routine development

Read-only investigation and delegated log/research chores are permitted under the same route guard for every executor. Source searches, bounded loopback probes and dev status/logs must never implicitly repair or mutate anything. Fable does not visually review images; use Codex or the configured lower-model helper. A legacy command exception is not evidence that a script is read-only. Arbitrary database diagnostic scripts without independently read-only execution remain unresolved; do not hide that gap by switching modes or adding a per-command owner ritual.
