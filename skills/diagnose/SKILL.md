---
name: diagnose
description: Diagnose Fabex activation, state health, platform facts, hooks, and Codex SDK installation.
---

# Diagnose

Owner-facing reply: mode badge first; Claude-authored summary with model-aware label; Codex ownerSummary from relay unchanged; Decided; Action required; TODO tagged Claude or Codex. Omit empty/absent-partner sections, routine none flags and JSON. Ordinary paragraphs, no block quotes. Preserve risks and unresolved disagreement. Both internal phases still run; result and relay --full expose complete answers within bounded history retention. Missing summaries fall back visibly. Wait in slices of at most 120 seconds, repeat on exit 3, never treat timeout as completion.

For phone uploads, verify the current hook-recorded session matches the upload's session directory and that `CLAUDE_CONFIG_DIR` is honored. Do not scan or inspect uploaded photos with Fable. After reload, ask for one non-sensitive phone photo, forward its host-provided reference through Phase 1, and check indexed attachment delivery. Root validation tests are not proof that the host reference was forwarded automatically.

For 1.8.1, verify schema 14 activation and the Stop relay check with a full-answer/truncated-answer probe in isolated state. Image and structured-review support need live post-reload checks; unit tests are not live activation proof. Permission profiles remain deferred: `--sandbox` does not combine with profile deny rules. The host ignored the ARGUMENTS rewrite in live dogfood; report that platform limitation, not a verified fix.

Report `codex.model` source and verification status. A configuration default is not proof of the served model; unknown stays unknown. The `fabex` source applies only to new threads and does not certify Desktop invisibility. The argument rewrite needs a live typed-mode probe after reload; unit tests establish only the returned hook output.

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs diagnose` from the project root. Report the factual activation block: source and registry versions, match, hook validity, reload requirement or unknown, last recorded turn/version, and verdict. Also report state health, safe lock metadata, SDK installation, repository root, network switch, and broad command warnings. After updating to 1.8.0, diagnose must precede the first Codex task. Confirm the stable evidence, lifecycle, compaction, wake, and owner-mode-grant hooks are registered. Never claim activation when the verdict is unknown or unverified.


## 1.8.0 reliability workflow

Use `controller.mjs relay --operation-id <uuid>` to obtain only the exact relayBlock, and paste it unmodified. Ordinary both-participant image-only requests use `ownerMessage: ""` with attachments; mode uploads use repeated `--attach` arguments before grant consumption. Prefer `previousReplyStatus: "recorded"`; unavailable evidence must be reported, not invented or truncated. Healthy discussion/ask allow only validated external scratch/memory writes, never project writes. Image restrictions remain in unhealthy states. Follow `docs/acceptance-1.8.0.md`; automated tests do not establish live phone or resource behavior.

Inspect `diagnose.claude.lastSessionStart` for the bounded source and model-field status, and `diagnose.claude.explanation` for the honest fallback. Same-session model-less starts retain prior evidence; PostModelSwitch recaptures `to_model` on supported hosts. A session model is not proof of the model serving every response.
