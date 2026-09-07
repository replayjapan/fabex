# 1.8.3 no-configuration development acceptance

## Automated checks

`pnpm test` must pass, including all prior protocol/security tests and these named tests in `tests/unit/regressions-1.8.3.test.mjs`:

- **ordinary dev/start commands work without configuration for main and operational executors**: all three managers, bare/run forms; other agents and read-only mutations denied; existing verification commands retained.
- **directory selectors and cd honor actual host cwd and reject escaped or composed launches**: nested applications, selectors, symlink containment, no pretending that repositoryRoot changes shell cwd.
- **script inspection covers database chains, lifecycle hooks, nested scripts and source-write shapes**: named harmful markers plus unknown/indirect shell shapes remain controlled.
- **bounded loopback probes work in read-only routes without redirects, writes, bodies or config tricks**: safe local GET/HEAD and lsof, negative flag/host/proxy/redirect cases.
- **automatic discovery finds a nested app, manager and intended port without saving configuration**: script dev/start fallback, manager evidence, framework defaults and port pinning.
- **ambiguous applications and package managers require a choice instead of guessing**: explicit repository selection resolves ambiguity without inventing it.
- **auto-detected helper refuses an occupied intended port without launching or signalling**: no unrelated process is killed; discussion cannot start.
- **detected lifecycle reports command cwd port and stops from ownership without an override**: simulated complete helper lifecycle, no configuration needed for subsequent status or verified stop.

The names above have the prefix `1.8.3`. Existing 1.8.2 tests still cover process identity, stale PID refusal, detached spawn wiring, non-mutating inspection and bounded logs. Only the superseded configuration-gate/probe assertions change. No real server is started by these simulated tests.

Also run `git diff --check`, `claude plugin validate .`, and `node --test --test-name-pattern='public tree' tests/unit/package.test.mjs`.

## Live acceptance — required before claiming the regression fully resolved

1. In a project **without any devServer block**, update/reload 1.8.3 and select work. Ask for the existing app's development server. Do not require JSON or a first-use activation. Identify the actual nested repository and requested/established port.
2. Through the main/operational host executor, inspect the script/hooks and port, then run its ordinary package-manager command as a host background task. The real development endpoint must use port 3000 when that is the requested endpoint; test-port success is not a substitute. Inspect errors/logs, use the separately approved read-only database diagnostic, and do not migrate/reset/grant privileges.
3. Capture desktop and phone-width browser views through existing approved tooling. Codex inspects approved images; Fable uses its description. Verify LAN binding separately from a real phone request to the owner's hostname.
4. End a turn and verify the same background task survives. Restart/stop using the host's task control for that exact task, never an arbitrary PID or port occupant. Confirm shutdown and perform another start/readiness cycle. Host permissions/task lifetime may still block this: report them, do not bypass.
5. In discussion/ask, local bounded probes must work and dev/start/stop mutations must be denied. In an isolated disposable test project, verify migration-chained/predev scripts remain denied. Never exercise destructive negatives on real data.
6. Separately exercise the optional helper with **no devServer configuration**: start, status/logs, turn boundary, restart, stop. It must find the single application, report command/cwd/port and refuse a conflicting listener without killing/adopting it. Multiple apps must produce a focused choice, not a guessed launch.

Acceptance is pending until demonstrated through the installed host. A classifier pass does not prove native networking, database access, host-task ownership or persistence. Earlier interruption, queued-image restart and process/RAM gates remain pending. Custom/opaque launchers are not automatically approved merely because their script is named dev; use specific review rather than broad shell authority.
