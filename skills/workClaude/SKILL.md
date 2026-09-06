---
name: workClaude
description: Enter normal Claude conversation mode without automatic Codex consultation, while still routing every implementation to Codex.
---

# Work Claude

This skill is owner-invoked. `UserPromptExpansion` captures trailing command text byte-for-byte in private grant state without template interpolation. Use its grant exactly once with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants claude --grant <provided-id>`. The command consumes the grant only after success; with text it prints `OWNER MESSAGE (verbatim)` after the mode changes, and only then may Claude answer it. If an older Codex operation is active, wait for the named operation to stop and rerun the exact mode command; the paused grant and text remain valid. With no text it changes mode only. If no grant is present, do not change mode. Show the mode message and configured badge.

Claude answers ordinary questions and decisions without Codex. Raw Claude-only questions and answers are not relayed or stored in the structured checkpoint. For implementation, ask the owner to invoke `/fabex:work`; Claude must not change participants itself. Create `fabex-operational` with the effective `models.operational` value passed explicitly for the full Git delivery lane. Claude coordinates and verifies; normal-mode project writes by every Claude executor are allowlist-controlled.

Owner approval authorizes the action only and never overrides the prescribed executor. An executor exception is valid only when the owner explicitly names the alternate executor and Fabex records it with `executor-exception authorize` before use and clears it with `executor-exception reconcile` afterward. Decision prose never grants permission.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for each complete quote.
