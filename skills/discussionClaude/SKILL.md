---
name: discussionClaude
description: Enter persistent Claude-only read-only discussion without Codex consultation.
---

# Discussion Claude

`UserPromptExpansion` captures trailing command text byte-for-byte in private grant state without template interpolation. Use the supplied single-use grant with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode discussion --participants claude --grant <provided-id>` from the project root. The command consumes it only after success; with text it prints `OWNER MESSAGE (verbatim)` after the read-only mode is active, and only then may Claude answer it. If an older Codex operation is active, wait for the named operation to stop and rerun the exact command; expiry stays paused. With no text it changes mode only. Without the grant, do not change mode. Show the mode message and configured badge.

Claude discusses read-only without submitting a Codex SDK turn or causing project effects until `/workClaude` or `/work`. Raw Claude-only questions and answers are not relayed or stored in the structured checkpoint; owner-approved decisions and relevant bounded status may be recorded explicitly.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for each complete quote.

Run the mode command standalone: no `cd` prefix, `&&` chain, trailing command, or pipe. Paste the generated relay block unchanged: complete answer plus non-empty plain-language flags, never internal JSON metadata. Claude-only modes still do not invoke Codex.
