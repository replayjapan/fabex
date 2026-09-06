---
name: ask
description: Have Claude and Codex answer one question jointly through the canonical Codex SDK thread with a read-only sandbox.
---

# Ask

Codex is the default image reviewer. Fable uses Codex's description and must not open the images. When needed, use the configured lower-model operational helper and exact image-description envelope documented in jointly. Read-only research is permitted; do not change mode to obtain tools. An owner `attach: /absolute/image.png` line in the mode-command text explicitly selects an attachment without changing that text.

Use the jointly 1.7.1 protocol: optional owner-approved image paths in `attachments`, complete `relayBlock` quotes for both phases under Codex's label, then Fable's separate answer. Preserve Phase 2 corrections and structured review fields; never merge away Codex's words. Stop verifies complete answers. Only owner-requested interruption permits `recover abandon` to waive a completed cycle's relay.

`UserPromptExpansion` captures any trailing question byte-for-byte in private grant state; Fabex does not interpolate it into this template. Use the supplied single-use grant with `control.mjs mode ask-once --participants both --grant <provided-id>` and show the mode message. With no trailing text it changes mode only. With text the atomic command prints a read-only Phase 1 operation ID: wait, read the result and retained owner message, then submit Phase 2. The grant is consumed only after success. Without it, do not change mode. Apply the configured reply badge.

Follow the jointly skill's SDK submit/status/result protocol with the owner's question verbatim and parity watchdog. The controller resumes the canonical thread with `read-only`, verifies the exact `thread.started` ID, and queues behind active work when necessary. Attribute both conclusions, relay flags unedited, and converge. The next owner prompt restores the prior mode.
