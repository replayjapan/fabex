---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

This skill is owner-invoked. `UserPromptExpansion` captures command arguments byte-for-byte in private grant state and supplies a single-use grant ID; the Fabex template does not interpolate that text. If no grant is present, do not change mode. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both --grant <provided-id>` from the resolved workstream root and show the mode message. The atomic mode command consumes the grant only after success. With no trailing text it changes mode only. With text it prints a Phase 1 operation ID: wait for it, read its result (which returns the retained owner message), then submit Phase 2 normally. If an older Codex operation is active, wait for the named active operation; Fabex then applies the transition and creates the reserved Phase 1 automatically. Apply the configured reply badge. Both means every owner cycle uses independent Phase 1 followed by linked Phase 2 on the canonical verified Codex SDK thread; implementation phases use `workspace-write`, and mode changes never replace the thread ID.

Executor authority remains fixed: Codex authors project source; Claude may deliver directly under host permissions or optionally use `fabex-operational` with its configured model; Claude coordinates and verifies. Direct file-tool writes and recognized source-writing shell/MCP shapes are guarded. Routine operational effects are not generally allowlisted. Only a structured owner-named `executor-exception authorize` record changes source-authoring authority.

Every both-participant owner cycle uses the strict independent/reconcile envelopes described by `/fabex:jointly`. Exact verification command patterns may grant a single argv shape without granting general project writes.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for the completed owner-facing summary.

Run the mode command standalone: no `cd` prefix, `&&` chain, trailing command, or pipe. Paste the generated relay block unchanged: Codex-authored summary or visible full-answer fallback plus non-empty flags, never internal JSON metadata. Claude-only modes still do not invoke Codex.

## 1.9.0 routine development

Within owner-authorized development, review the actual repository, scripts and lifecycle hooks, database target, and effects. Run necessary installs, generated lockfile updates, reviewed forward development migrations, scoped fixtures, diagnostics and server work without new per-command approvals or handwritten exceptions. Codex still authors project source; generated artifacts and development database effects are not automatically source authorship. Never run destructive resets, production changes or unrelated privileged operations, or use scripts/MCP to evade authorship. Use a permitted host executor when native SDK restrictions prevent execution; never bypass host security or send the owner to the terminal. Stop only a verified host-owned task or the existing ownership-checked helper, never generic kill. Verify actual readiness, logs, conflicts and persistence. The deny list is a backstop, not proof that a script is safe.
