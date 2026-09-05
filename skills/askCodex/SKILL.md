---
name: askCodex
description: Ask Codex one read-only question through the canonical verified SDK thread and relay it.
---

# Ask Codex

Use the single-use grant supplied by this owner-typed slash command. Run Fabex `status`, `config`, and `diagnose`, then `control.mjs mode ask-once --participants codex --grant <provided-id>` and show the mode message. Without the grant, do not change mode. Apply the configured reply badge.

Submit one direct controller turn with the owner's question verbatim and the parity watchdog. This Codex-only route does not use the both-participant two-phase envelope. The controller resumes the canonical thread with `read-only` and verifies the exact `thread.started` ID. Attribute Codex, relay flags unedited, and note that the next prompt restores the prior mode.
