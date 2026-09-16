# 1.9.3 recovery acceptance

The legacy reservation was recovered by the host executor with explicit owner
authorization, a scoped executor exception, a stored audit and zero signals.
An empty queue was independently observed before verification. Schema remains 16.
Automated results are reported in the release handoff; real-host checks below
remain distinct from passing fixture tests. Do not claim activation before reload.

## Automated gates

- Run `pnpm test` serially after authorized recovery; include 1.9.2 message,
  mode-grant, queued-owner-message and continuation coverage unchanged.
- Run `git diff --check`, plugin validation and the public-tree privacy test in
  the copy, then in source after a verified sync.
- Regression fixtures cover wrapper field preservation/identity, group/legacy
  refusal, audited owner authorization, SDK interruption evidence, live locks,
  probe timeout/outside-lock sampling, budgets, classification and wording.

## Combined host sequence — pending

1. Preserve an active job across plugin reload and real restart; neither event
   alone releases it. Verify updatedInput is honored with the original cwd,
   exported environment, stdin/stdout/stderr and exit status. Check a host
   background task too. Report unavailable acknowledgement honestly.
2. Omit a completion event: a managed child and empty group support evidence
   release. A live descendant in that group prevents release. No process is killed.
3. Cancel an SDK operation and interrupt its stream. Verify the native CLI/group
   identity, preserve surviving work and release only a verified empty group.
   Check both supported launcher and unknown-identity fallback behavior.
4. Recover a legacy record only after explicit owner-named authorization, recorded
   as a scoped executor exception or an exact recovery prompt. Inspect the audit
   and reconcile the exception. The actual legacy recovery has passed; fixture
   tests also check refusal without matching authorization.
5. Kill a fixture lock owner mid-write, verify recovery warning and intact JSON;
   preserve unknown/replacement locks. No source, database or unrelated process
   is a failure-injection target.
6. Exercise wait-budget exhaustion without repeated retry calls, loss of an
   unfinished phase or missing relay. Verify the bounded wake message actually
   arrives in the host and queued owner messages still retain their references.
7. Continue one task from a plain message and one from a mode command with text.
   Confirm references insert originals once, duplicate submissions do not run
   twice, and reports distinguish references from substitutions.
8. Measure memory pressure/swap and owned-process RSS before/during/after a single
   approved check. Preserve requested previews. Missing probes mean unknown.

No browser, database, server, permission setting, network default or model label
is changed by these tests automatically. Host checks above are not established
by fake-process unit fixtures. Do not claim measured RAM savings or crash immunity.
