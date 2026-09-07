# 1.8.2 development-loop acceptance

Automated process tests use injected process/HTTP operations. They do **not** demonstrate native port binding, browser behavior, a real turn boundary or database connectivity. No development server is started by this release's regression suite.

## Automated checks

Run `pnpm test`. Named regressions in `tests/unit/regressions-1.8.2.test.mjs`:

| Test | Evidence |
| --- | --- |
| 1.8.2 project-only dev config is strict, cwd-contained and disabled on error | argv, timings, loopback URL/port, unknown keys, machine-layer rejection, canonical cwd and symlink escape |
| 1.8.2 dev guard enforces every route/executor and grants no generic shell or migrations | lifecycle main/operational only in work; read controls in work/discussion/ask; recovery/unhealthy deny; standalone shapes; direct commands remain denied |
| 1.8.2 simulated lifecycle survives calls and restarts/stops only its owned process group | sidecar reuse between calls, explicit repository cwd/argv, restart, TERM and verified KILL |
| 1.8.2 port conflicts fail visibly without launching or killing unrelated listeners | conflict PID/command surfaced, no launch/signal |
| 1.8.2 stale PID and identity mismatch clear only the record and never signal | dead/reused PID, no killing, occupied port still conflicts |
| 1.8.2 status and bounded redacted logs never mutate, repair or signal | stale state and logs unchanged, no mutation authorization invoked, bounded output |
| 1.8.2 ownership changes before a signal fail closed and log symlinks are refused | immediate identity recheck, no unverified signals, no log symlink following |
| 1.8.2 native adapter preserves detached argv and parses bounded process evidence without a server | spawn options/stdio/unref and process evidence parsing, using a fake child |
| 1.8.2 disabled/absent inspection, lock conflicts and inspection failures have no lifecycle side effects | read controls create nothing, failed inspection does not launch, a lifecycle lock is not stolen |
| 1.8.2 child listener ownership is group-scoped and orphaned children are not guessed or killed | child listener is ours only while the recorded leader identity remains verified; incomplete stop reports failure |

All existing protocol/security regressions remain required. Also run `git diff --check`, `claude plugin validate .`, and `node --test --test-name-pattern='public tree' tests/unit/package.test.mjs`.

## Live checks — pending in the owner's project session

1. Update/reload the plugin and verify loaded/source version 1.8.2. Merge the owner-approved project `devServer` block; preserve existing config and exact script permissions. Inspect config/diagnose; do not enable network globally or change databases.
2. In owner-selected work, execute standalone `control.mjs dev start` via the host main session or verified operational executor. It must launch the intended nested repository on **port 3000**. If native permissions deny launch/network/inspection, report the host denial; do not bypass it. If the port is occupied by an unowned listener, report the conflict, do not adopt/kill it.
3. Run `dev status` and bounded `dev logs`. Confirm owned listener, HTTP localhost:3000 readiness, startup/runtime errors and the correct development database using the separately reviewed exact diagnostic script. No migration, reset, account, or grant action is implied.
4. Use existing approved screenshot/browser tooling for desktop and phone-width captures. Codex reviews approved images directly; Fable uses Codex's description. A successful HTTP response is not sufficient app verification.
5. End the turn, send another owner message, and verify the same owned server is still available. Switch to discussion: status/logs should work without mutation; start/stop/restart must be denied.
6. Owner selects work again: restart, verify new owned PID and readiness, then stop and confirm the listener is gone. Never kill an unrelated listener that acquired the port. A stale ownership record must clear without signalling. Exercise negative process cases only with isolated disposable fixtures, never another user's real process.
7. Verify binding to all interfaces separately from an actual phone request to the owner's LAN hostname. Phone-width browser captures and port-3107 test runs are not proof that the phone can reach port 3000.

Remaining earlier acceptance gates: interruption with mode switch, restart while an image is queued, and process/RAM stability across repeated cycles. These are not marked passed by 1.8.2. Private log content may be sensitive despite best-effort redaction; do not publish raw logs or credentials. A crashed lifecycle command's separate lock requires verified manual cleanup, not automatic status repair.
