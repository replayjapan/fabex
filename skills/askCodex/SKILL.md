---
name: askCodex
description: Ask Codex one read-only question through the canonical verified SDK thread and relay it.
---

# Ask Codex

`UserPromptExpansion` captures any trailing question byte-for-byte in private grant state instead of exposing it in this prompt. Use the supplied single-use grant with `control.mjs mode ask-once --participants codex --grant <provided-id>` and show the mode message. With no text it changes mode only. With text the atomic command prints a new read-only Codex operation ID; wait and relay its result. The grant is consumed only after success. Without it, do not change mode. Apply the configured reply badge.

Submit one direct controller turn with the owner's question verbatim and the parity watchdog. This Codex-only route does not use the both-participant two-phase envelope. The controller resumes the canonical thread with `read-only` and verifies the exact `thread.started` ID. Attribute Codex, relay flags unedited, and note that the next prompt restores the prior mode.
