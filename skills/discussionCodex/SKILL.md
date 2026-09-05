---
name: discussionCodex
description: Enter persistent read-only Codex relay mode using the canonical verified SDK thread.
---

# Discussion Codex

`UserPromptExpansion` captures trailing command text byte-for-byte in private grant state instead of exposing it in this prompt. Use the supplied single-use grant with `control.mjs mode discussion --participants codex --grant <provided-id>` from the resolved workstream root and show the mode message. With no trailing text it changes mode only. With text the atomic command prints a new read-only Codex operation ID; wait and relay its result. The grant is consumed only after success. Without it, do not change mode. Apply the configured reply badge.

For every owner message, submit one direct controller turn with the owner's message verbatim and the parity watchdog. This Codex-only route does not use the both-participant two-phase envelope. The controller queues each turn, resumes the exact canonical ID with `read-only`, and verifies `thread.started`. Attribute Codex, relay flags unedited, and keep Claude substantively silent. Mode changes never clear continuity.
