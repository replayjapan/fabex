---
name: askCodex
description: Ask Codex one read-only question through the canonical verified SDK thread and relay it.
---

# Ask Codex

`UserPromptExpansion` captures any trailing question byte-for-byte in private grant state without template interpolation. Use the supplied single-use grant with `control.mjs mode ask-once --participants codex --grant <provided-id>` and show the mode message. With no text it changes mode only. With text the atomic command prints a new read-only Codex operation ID; wait and relay its result. The grant is consumed only after success. Without it, do not change mode. Apply the configured reply badge.

Submit one direct controller turn with the owner's question verbatim and the parity watchdog. This Codex-only route does not use the both-participant two-phase envelope. The controller resumes the canonical thread with `read-only` and verifies the exact `thread.started` ID. Attribute Codex, relay flags unedited, and note that the next prompt restores the prior mode.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for each complete quote.
