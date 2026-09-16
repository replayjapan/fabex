# 1.9.2 acceptance — implementation versus live evidence

## Automated coverage

`tests/unit/regressions-1.9.2.test.mjs` exercises atomic competing admissions,
completion and background-task bookkeeping, waiting/resumption, expired leases,
injected critical/warn/unknown memory readings, query-only probe arguments,
resource retain and stale-identity refusal, bounded Stop continuation, mode-grant
text capture, exact recorded references, small-mismatch substitution, ambiguity,
duplicate submissions and non-mutating read controls. Existing protocol,
ownership, privacy and migration-gate tests must remain green.

Automated injected events and memory fixtures do not prove actual Claude Code
hook payloads, native SDK admission, RAM savings or a working browser lifecycle.

The source-edit sandbox's query-only probe returned free percentage and page
counters, but pressure-level and swap sysctls and process RSS were unavailable.
Those values stayed explicitly unknown. This does not establish whether the
host executor can obtain them; verify that after reload, without a stress test.

## Live checks after update, reload and quiescent migration

1. Verify schema 16 migrates losslessly only with no live old runner. Confirm both
   partners, exact summaries, mode grants and the canonical thread still work.
2. Start one harmless recognized heavy host job. Attempt another while it runs:
   it must wait/retry automatically, not ask the owner to say continue. Check the
   foreground, failed, denied and background completion events all release only
   the right reservation. Verify task-output and stop acknowledgements. Run a
   sequential Codex/Claude pair and inspect actual SDK command events, not phase
   labels. Do not stress the computer to demonstrate critical pressure.
3. Read mem before/during/after ordinary checks. Record timestamps, pressure,
   swap/page counters and runner/SDK RSS; identify unavailable probes explicitly.
   Compare comparable workload peaks before/after; percentages alone are not
   savings. Confirm other apps and worker children are outside the scheduler.
4. Start a requested preview, a forwarder and a browser through the permitted
   host controls. List tracked resources, retain the preview with a note, release
   the rest and verify their actual completion. Native browser/MCP contexts not
   tracked as host tasks must be inspected through their own controls. Never kill
   an unrelated process or adopt a port occupant. Confirm stale identities refuse.
5. Complete at least two real linked cycles under one plain recorded owner
   message, then under a mode-command task. No extra owner prompt should be needed.
   Set/clear authorized open-work and genuine blocker/action fields. Confirm new
   questions disarm prior work, budget exhaustion is visible and discussion/ask
   never resumes implementation. Preserve cancellation and in-flight cycle checks.
6. Submit a specific prompt digest once and retry the identical requestId: one
   operation only. Test sole-candidate latest and ambiguous latest, queued messages,
   harmless whitespace and small differences; inspect that Codex receives the
   original, not reconstructed words. No notification becomes owner authority.
7. Review the visible reply: five-sentence Claude guideline, separately authored
   Codex summary, material risks, decisions and only genuine owner actions.

## Known limits / safety choices

- Serialization is per workstream and recognized host shapes, not a global FIFO.
  SDK event observation cannot prevent a command that has already started.
- A six-hour lease warning is not proof of death. Unknown reservations remain
  until verified host completion; a missed event may need recovery investigation.
- Unknown pressure warns rather than blocks; native sandbox restrictions remain.
- Resource records never authorize raw PID termination. No automatic kill at
  checkpoints. Browser/MCP processes outside host tasks remain manually accounted
  for by the executor, not the owner.
- A new owner prompt resets but disarms the continuation budget. A stale TODO is
  not permission. Host errors, limits and cancellations can still stop work.
- Raw prompt retention is at most eight entries/2 MiB, at most 192 KiB of text per
  entry, outside the workstream with mode 0600. Pruned text can require the explicit-text route; oversized
  messages still exceed the existing submission cap; Claude-only raw text and notifications are not retained.
- No real project server, database, production system or destructive memory-load
  test is needed for source verification. Real-host checks remain pending until
  performed and recorded explicitly; do not mark them passed from fixtures.
