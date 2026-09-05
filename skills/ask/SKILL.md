---
name: ask
description: Have Claude and Codex answer one question jointly through the canonical Codex SDK thread with a read-only sandbox.
---

# Ask

Use the single-use grant supplied by this owner-typed slash command. Run Fabex `status`, `config`, and `diagnose`, then `control.mjs mode ask-once --participants both --grant <provided-id>` and show the mode message. Without the grant, do not change mode. Apply the configured reply badge.

Follow the jointly skill's SDK submit/status/result protocol with the owner's question verbatim and parity watchdog. The controller resumes the canonical thread with `read-only`, verifies the exact `thread.started` ID, and queues behind active work when necessary. Attribute both conclusions, relay flags unedited, and converge. The next owner prompt restores the prior mode.
