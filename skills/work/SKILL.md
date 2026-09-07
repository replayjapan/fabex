---
name: work
description: Enter normal joint work mode, where Claude and Codex use Fabex routing and Codex performs every implementation.
---

# Work

This skill is owner-invoked. `UserPromptExpansion` captures command arguments byte-for-byte in private grant state and supplies a single-use grant ID; the Fabex template does not interpolate that text. If no grant is present, do not change mode. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs mode normal --participants both --grant <provided-id>` from the resolved workstream root and show the mode message. The atomic mode command consumes the grant only after success. With no trailing text it changes mode only. With text it prints a Phase 1 operation ID: wait for it, read its result (which returns the retained owner message), then submit Phase 2 normally. If an older Codex operation is active, wait for the named active operation; Fabex then applies the transition and creates the reserved Phase 1 automatically. Apply the configured reply badge. Both means every owner cycle uses independent Phase 1 followed by linked Phase 2 on the canonical verified Codex SDK thread; implementation phases use `workspace-write`, and mode changes never replace the thread ID.

Executor authority remains fixed: Codex performs every project file edit; create `fabex-operational` with the effective `models.operational` value passed explicitly for the full Git delivery lane; Claude coordinates and verifies. Normal-mode Claude project writes, including subagents, Bash, and mutating MCP tools, are denied by allowlists. Only a structured owner-named `executor-exception authorize` record can bypass project edit authority.

Every both-participant owner cycle uses the strict independent/reconcile envelopes described by `/fabex:jointly`. Exact verification command patterns may grant a single argv shape without granting general project writes.


## 1.8.0 mode attachments and relay

Before consuming the owner grant, forward every current-message host upload reference as a repeated `--attach <absolute-path>` argument to the mode command. Do not open or describe images and do not append the host note to the owner text. This lets mode-created Phase 1 see the images immediately, including with an empty caption; waiting transitions retain the selections. Explicit `attach:` lines still work. Missing/unsupported/oversized files fail the whole transition visibly; do not retry text-only. Claude-only modes do not send images to Codex and reject Codex attachment arguments—report that boundary without switching modes. Codex-only ordinary messages may use `{"phase":"single","ownerMessage":"","attachments":["/absolute/approved/photo.jpg"]}`. In both-participant cycles, wait for Phase 1, then reconcile normally. Use `controller.mjs relay --operation-id <uuid>` for each complete quote.

Run the mode command standalone: no `cd` prefix, `&&` chain, trailing command, or pipe. Paste the generated relay block unchanged: complete answer plus non-empty plain-language flags, never internal JSON metadata. Claude-only modes still do not invoke Codex.

## 1.8.2 development server

For an owner-configured devServer lane, the main host session or verified operational executor may run standalone `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs dev start|stop|restart` in healthy owner-selected work mode. Use `dev status` and `dev logs --lines 80` for bounded inspection. The host must have native process/network permission; Codex's sandbox is not bypassed. Existing approved screenshot scripts can supply images for Codex review. Never kill a port occupant or grant migrations implicitly.
