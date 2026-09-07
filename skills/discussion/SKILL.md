---
name: discussion
description: Enter persistent joint discussion on the canonical Codex SDK thread with a mechanical read-only sandbox.
---

# Discussion

For phone photos, forward the host-supplied upload file reference for this owner message in Phase 1 `attachments`, without opening or describing it. Preserve ownerMessage verbatim; do not append the host note. The controller requires the hook-recorded upload session and limits each image to 16 MiB. Do not scan or guess upload files. Follow jointly's selected/submitted/delivered/failed reporting; a validation error must never become a silent text-only retry. If mode-created Phase 1 already omitted the file, report the gap.

Codex is the default image reviewer. Fable uses Codex's description, not its own image inspection. An optional configured lower-model helper may describe images using jointly's exact read-only delegation envelope. WebFetch, WebSearch, and claude-code-guide are available for read-only research. Owner `attach: /absolute/image.png` lines select Phase 1 images; ordinary path mentions do not. Never switch mode to access these tools.

Use the jointly 1.8.0 protocol for approved screenshot paths in `attachments` and structured reviews. Both image phases keep the SDK's read-only sandbox and independent-first sequencing. Paste the complete result `relayBlock` for each phase before Fable's view, with Phase 2 corrections separately visible. Never replace Codex's full words with a merged summary. Owner-requested interruption may waive a completed cycle through `recover abandon`.

`UserPromptExpansion` captures any trailing command text byte-for-byte in private grant state; Fabex does not interpolate it into this template. Use the supplied single-use grant with Fabex `config`, then `control.mjs mode discussion --participants both --grant <provided-id>` from the resolved workstream root and show the mode message. The atomic command consumes the grant only after success and interrupts any unreconciled prior Phase 1. With no trailing text it creates no operation. With text it prints a new read-only Phase 1 operation ID: wait, read the result and retained owner message, then submit its linked Phase 2. If older work is active, wait for the named operation to stop; the discussion transition and reserved read-only Phase 1 then apply automatically. Without the grant, do not change mode. Apply the configured reply badge.

Remain read-only until the owner types `/work`. Run every owner cycle through the jointly skill's two-phase SDK protocol with the parity watchdog. The durable queue preserves owner-cycle order, and both phases resume the canonical ID with the SDK's `read-only` sandbox. Converge only after exact `thread.started` verification and relay flags unedited.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for each complete quote.

Run the mode command standalone: no `cd` prefix, `&&` chain, trailing command, or pipe. Paste the generated relay block unchanged: complete answer plus non-empty plain-language flags, never internal JSON metadata. Claude-only modes still do not invoke Codex.

## 1.8.3 development server

Use exact lsof port inspections and bounded HTTP loopback GET/HEAD probes, or the existing control.mjs dev status/logs helpers, without project configuration. Example: curl -q --noproxy '*' --max-time 5 -I http://localhost:3000/. Do not follow redirects off loopback or inspect images yourself. Development start/stop/restart and database mutations remain denied here. No implicit repair or owner-mode change. In work mode, ordinary inspected dev/start scripts are now built in; configuration is only an optional helper override.
