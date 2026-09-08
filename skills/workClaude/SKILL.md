---
name: workClaude
description: Enter normal Claude conversation mode without automatic Codex consultation, while still routing every implementation to Codex.
---

# Work Claude

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

This skill is owner-invoked. `UserPromptExpansion` captures trailing command text byte-for-byte in private grant state without template interpolation. Use its grant exactly once with `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants claude --grant <provided-id>`. The command consumes the grant only after success; with text it prints `OWNER MESSAGE (verbatim)` after the mode changes, and only then may Claude answer it. If an older Codex operation is active, wait for the named operation to stop and rerun the exact mode command; the paused grant and text remain valid. With no text it changes mode only. If no grant is present, do not change mode. Show the mode message and configured badge.

Claude answers ordinary questions and decisions without Codex. Raw Claude-only questions and answers are not relayed or stored in the structured checkpoint. For source implementation, ask the owner to invoke `/fabex:work`; Claude must not change participants itself. Claude may deliver directly under host permissions or optionally use `fabex-operational` with its configured model. Claude coordinates and verifies. Routine operational effects defer to the host after target/effect review; Codex retains source authorship.

Owner approval authorizes the action only and never overrides the prescribed executor. An executor exception is valid only when the owner explicitly names the alternate executor and Fabex records it with `executor-exception authorize` before use and clears it with `executor-exception reconcile` afterward. Decision prose never grants permission.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for the completed owner-facing summary.

Run the mode command standalone: no `cd` prefix, `&&` chain, trailing command, or pipe. Paste the generated relay block unchanged: Codex-authored summary or visible full-answer fallback plus non-empty flags, never internal JSON metadata. Claude-only modes still do not invoke Codex.

## 1.9.0 routine development

Within owner-authorized development, review the actual repository, scripts and lifecycle hooks, database target, and effects. Run necessary installs, generated lockfile updates, reviewed forward development migrations, scoped fixtures, diagnostics and server work without new per-command approvals or handwritten exceptions. Codex still authors project source; generated artifacts and development database effects are not automatically source authorship. Never run destructive resets, production changes or unrelated privileged operations, or use scripts/MCP to evade authorship. Use a permitted host executor when native SDK restrictions prevent execution; never bypass host security or send the owner to the terminal. Stop only a verified host-owned task or the existing ownership-checked helper, never generic kill. Verify actual readiness, logs, conflicts and persistence. The deny list is a backstop, not proof that a script is safe.
