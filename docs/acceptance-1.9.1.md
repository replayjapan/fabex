# 1.9.1 acceptance

This release includes the pending 1.9.0 source correction. No schema rollback or
network/host permission change is part of this patch. Automated policy tests are
not proof that a host will execute a delivery command.

Schema 15 identifies the extended review shape. Schema 14 migrates losslessly,
including legacy complete answers and queued work; live-runner migration defers.
The controller relay integration regression also verifies this gate and equality
of the migrated state apart from schema/generation.

## Automated checks

Named tests in `tests/unit/regressions-1.9.1.test.mjs`:

- `1.9.1 schema requires bounded author-owned summaries while stored legacy reviews remain valid`
- `1.9.1 relay uses summary paragraphs, flags and difference notice without JSON or transcript dumping`
- `1.9.1 Stop verifies linked Phase 2 summary and label, retains legacy and independent obligations`
- `1.9.1 Claude model source prefers session, strips context suffix, labels configured and unknown honestly`
- `1.9.1 Git delivery defers only for work-mode main or verified operational executor`
- `1.9.1 controller wait cap and exact relay --full shape retain read-only access`
- `1.9.1 controller relay --full prints full stored answer and default prints owner summary`

Run the full `pnpm test` suite, `git diff --check`, `claude plugin validate .`,
and the public-tree privacy test. Existing grants, image transport, canonical
thread, recovery, migration gates and legacy relay tests remain required.

## Live checks — pending

1. After update/reload, send an ordinary question. Confirm mode badge, Claude
   summary with model label, unchanged Codex summary, and only useful Decided,
   Action required and TODO sections. No routine none flags or quote bars.
2. In a model-less resume, confirm a configured default is visibly marked
   configured and unverified in status/diagnose; with no evidence, show unknown.
   Do not assert that a specific model is present in every installation.
3. Ask to see the full phase records. Claude retrieves result/relay --full for
   both linked IDs while retained. Do not promise permanent archive retention.
4. Claude attempts reviewed owner-authorized direct delivery and records the
   exact host outcome. No speculative permission rule or alternate bypass.
5. During a long operation, use short repeated waits (at most 120 seconds),
   continue on exit 3, and finish both phases before ending the owner cycle.
   Inspect any Stop hook feedback before attributing its cause to host rendering.

The 1.9.0 disposable-database/dependency/fixture/browser/server lifecycle gates,
queued-image restart, interruption and resource-stability checks remain pending;
this output patch does not establish their results.
