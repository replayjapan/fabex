---
name: jointly
description: Use for build, fix, change, implement, create, or update requests and for substantive questions or decisions; route clear mechanical implementation straight to Codex with Claude verification, use blind independent Claude and Codex views for judgment, converge honestly, and give all implementation to Codex.
---

# Jointly

Use one of two lanes. Codex performs all file edits in both lanes. Native permissions and the Codex sandbox remain authoritative.

A question is not an implementation request. Never enter the Implement lane or launch a `--write` task unless the user explicitly requests a project change.

You MUST delegate every image or screenshot inspection, GitHub or `gh` command sequence, and log-dump analysis to `fabex-operational`; do not perform any part of those in the primary session. Select its model from the effective `models.operational` config.

## Route deterministically

- **Implement lane (default):** Use for build, fix, change, implement, create, or update requests that have explicit acceptance criteria or are mechanical fixes. Do not form or state an independent implementation analysis.
- **Decide lane:** Use when the request requires choosing an approach, architecture, design, or tradeoff, or asks a substantive judgment question. If code is also requested, keep both views complete but brief and about the approach only; after convergence, enter the Implement lane.
- **Pure questions:** Use the Decide lane for substantive questions. Skip this skill for greetings and trivial lookups. `/askClaude` and `/askCodex` remain the explicit single-AI escapes.

From the project root, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs config`, `status`, and `diagnose`. Use the canonical project root, companion location, and configured Codex arguments: include `--model <model>` only when the model is non-null, then `--effort <reasoningEffort>`.

## Implement lane

Never edit files yourself by any mechanism: do not use Write/Edit, shell, node scripts, or any other path. Codex alone performs every edit. Iterate only through short corrective Codex tasks, then reverify.

1. State one short framing line containing only the task and acceptance criteria from the user's words. For a mechanical fix without separately stated criteria, treat the requested behavior itself as the criterion; do not invent criteria. Do not add bug-by-bug analysis, a proposed fix, or convergence ceremony.
2. Immediately launch a fresh write-enabled background companion task:

   `node <companion-location>/scripts/codex-companion.mjs task --json --background --cwd <canonical-project-root> --fresh --write [--model <model>] --effort <reasoningEffort> '<prompt>'`

   The prompt must contain the user's message verbatim plus the acceptance criteria and no Claude implementation analysis. Require Codex to return only this bounded summary: status, files changed, diffstat, tests or criteria checked with exit codes, unresolved risks, and decisions needed.
3. Fetch with the exact companion `status --json --wait --cwd ... <job-id>` and `result --json --cwd ... <job-id>` forms. Read and relay only the bounded summary, never a full transcript.
4. Independently run the user's stated tests or criteria in the Claude session and collect their exit codes and a bounded diffstat. For a mechanical fix, also run relevant existing tests. Do not treat Codex's reported checks as Claude verification. Avoid rereading whole files; narrow diff inspection is allowed for security-sensitive changes.
5. Report the implementation and verification results honestly. If verification fails, launch another fresh `--write` task with short corrective instructions containing only the failed criterion, essential failure evidence, and requested correction. Reverify; do not create a parallel implementation analysis.

## Decide lane

1. Before forming or stating Claude's view, launch a fresh read-only background companion task:

   `node <companion-location>/scripts/codex-companion.mjs task --json --background --cwd <canonical-project-root> --fresh [--model <model>] --effort <reasoningEffort> '<prompt>'`

   The prompt must contain the user's message verbatim plus only neutral context needed to orient Codex. Never include Claude's opinion, draft, preferred direction, or suggested answer. Never include `--write` in this opening task.
2. While Codex runs, form Claude's independent view. State Claude's complete view as visible assistant text before any `status` or `result` call. When followed, that transcript ordering provides an auditable blindness protocol.
3. Only after Claude's visible view, fetch with the exact companion `status --json --wait --cwd ... <job-id>` and `result --json --cwd ... <job-id>` forms. Present both views, identify material disagreements without smoothing them over, and state the converged decision.
4. If implementation is requested, enter the Implement lane with the user's request verbatim, the converged approach, and the acceptance criteria. Use a fresh task with `--write`; do not repeat either model's implementation analysis.

Efficiency rules: relay Codex work as bounded schema summaries only. Never relay full transcripts. Verify implementation using independently collected test exit codes and diffstat, not by rereading whole files.

Use `--resume` or `--resume-last` only for read-only follow-up in the same context. Every independent opening view and every implementation or corrective task starts fresh.
