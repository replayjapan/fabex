---
name: ask
description: Have Claude and Codex answer one question jointly through the canonical Codex SDK thread with a read-only sandbox.
---

# Ask

`UserPromptExpansion` captures any trailing question byte-for-byte in private grant state; it is never interpolated into this prompt. Use the supplied single-use grant with `control.mjs mode ask-once --participants both --grant <provided-id>` and show the mode message. With no trailing text it changes mode only. With text the atomic command prints a read-only Phase 1 operation ID: wait, read the result and retained owner message, then submit Phase 2. The grant is consumed only after success. Without it, do not change mode. Apply the configured reply badge.

Follow the jointly skill's SDK submit/status/result protocol with the owner's question verbatim and parity watchdog. The controller resumes the canonical thread with `read-only`, verifies the exact `thread.started` ID, and queues behind active work when necessary. Attribute both conclusions, relay flags unedited, and converge. The next owner prompt restores the prior mode.
