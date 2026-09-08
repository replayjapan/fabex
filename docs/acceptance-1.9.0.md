# Acceptance — 1.9.0

Status: source-policy correction, not a demonstrated restoration of the full
development workflow. No server or database is started by the unit suite below.

## Automated checks

- `1.9 routine work defers without per-command configuration`: installs,
  migration status/execution, fixtures, scripts, source searches and local HTTP;
  main and delegated executors.
- `1.9 targeted work backstops name the denied effect`: resets, destructive SQL,
  privileged operations, explicit production mutations, deployments and kill.
- `1.9 source authorship and Git delivery remain separate`: direct writers,
  rewrite flags, delivery and command-bearing MCP checks.
- `1.9 discussion reads do not trust mutating exceptions`: expanded read tools,
  mutations and interpreter escapes denied even with matching legacy patterns.
- `1.9 image metadata and read-only delegation do not confer mutation authority`:
  PNG stat allowed; direct image Read denied; delegated mutations denied.
- Existing 1.8.2/1.8.3 fake-process tests: occupied-port refusal, stale/reused PID
  refusal, identity verification, bounded non-mutating status/logs and owned stop.
- Existing phase/grant/relay/canonical-thread/migration/recovery/privacy tests.

## Required live checks — pending

The team runs these through the authorized host executor, not by asking the
owner to operate a terminal or write command exceptions. Check installed version,
effective config, repository cwd and executor identity first. No production
connection, reset, elevated grant or unrelated process may be used.

1. Identify a disposable development database without printing credentials.
   Read its schema and migration ledger. Review an appropriate forward migration
   and run it there, then verify the intended schema change. A named command or
   missing-column error alone does not establish the correct database target.
2. Install dependencies using the repository's existing package manager and
   lockfile policy. Inspect lifecycle hooks first. Review any lockfile changes.
3. Apply scoped development fixtures/test accounts; verify their scope and
   recorded effects. Never substitute a destructive seed/reset operation.
4. Start the actual application on its intended port, inspect startup/runtime
   errors and readiness, and capture desktop and phone-width browser views.
   Codex performs visual review. LAN binding is not an actual phone test.
5. Verify persistence across a genuine turn boundary, restart, and stop only the
   verified owned process. Report a port conflict without killing its occupant.
6. In discussion and ask, perform source searches and read-only diagnostics;
   verify no repair, migration, install or lifecycle mutation occurs.

Native EPERM, unreviewable targets, custom read-only script execution, production
classification and missing original role evidence must be reported explicitly.
Classifier success, mock process tests and an unrelated test server do not close
these gates. Queued-image restart and resource-stability checks also remain open.
