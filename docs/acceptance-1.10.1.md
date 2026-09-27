# 1.10.1 acceptance

Automated fixtures cover name changes, spaces/Unicode, shared and explicit names,
thread continuity, streaming title/gauge reads, append/truncation, settings pipes,
checkpoint clearing, migration observation, MCP overrides and cleanup refusals.

Host acceptance (do not mark complete from unit tests):

- Rename a VS Code chat twice, including spaces; send a message and check title,
  milestone binding and a single canonical private archive. Resume its prior thread.
- Check a long rollout twice: initial coverage completes, the next read counts only
  appended records. Missing/unreadable metadata stays unavailable, never zero use.
- During an actual old-runner upgrade, observe status/wait without migrating state;
  completed relay still requires its independent seal.
- In an explicitly configured helper-off session, inspect the launched CLI's
  tool list/processes; compare inherit. Do not infer service availability or RAM
  savings merely from requested configuration.
- Audit disposable working copies only. Any unique file, unknown active use or
  permission denial leaves the copy intact. Never force removal.
- Confirm human overview, installation, update links and AI reference in both repos.
  No private paths, transcripts, usage databases or credentials may enter delivery.

No network defaults, host permissions, global MCP settings or live usage databases
are changed by this release. Claude performs reviewed Git delivery separately.

Implementation-turn evidence: the pinned CLI catalog accepted per-run overrides
for all six enabled user-configured helpers. One host/plugin-managed entry stayed
enabled and is reported separately. No model invocation or global config edit was
used. This confirms configuration handling, not process-level RAM savings.

The live retained rollout scan covered roughly 152 MB and counted 19 compaction
markers, including oversized records, using bounded buffers. Native sandbox
permissions prevented persisting its private index, so the result correctly
warned that a future read may rescan. Host-side cache persistence remains to check.
