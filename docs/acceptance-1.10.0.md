# 1.10.0 acceptance

Fixture tests cover the state and guard contracts. These live host checks remain
required after installation/reload; never substitute a setting for evidence.

- Resume a legacy project: preserve its thread, mode, checkpoint and permissions.
- Rename a VS Code chat; check its title and transcript reference. If the host
  supplies no readable title, use the optional milestone selector.
- Open two chats: verify session settings do not leak and a busy review cycle is
  not rebound. A new milestone starts its own thread; returning checks code state.
- Select an editor trial through owner settings; use an isolated source worktree
  and disposable database where needed. Confirm observed models and supported
  effort. Unavailable models must fail visibly, not fall back.
- Submit Phase 1, seal Claude's independently authored view, then read Codex.
  Verify waiting before the seal does not start the turn; reconciliation includes
  the sealed view. Complete pre-upgrade operations without changing their rules.
- Review a long-thread handoff, rotate at a safe boundary, confirm the new thread
  has its checkpoint, and verify the archived predecessor remains available.
- Inspect timestamped context snapshots; unavailable metadata remains unavailable.
- Enable the optional tracker in one chat: one start, checkpoint and closeout;
  thread rotation and retries do not duplicate starts. Verify account-wide
  allowance labels, reset times and stale readings. Disable it: no calls/notices.
- In discussion use genuinely read-only tracker reporting; verify no database
  import, creation or snapshot write. An enabled missing tracker never blocks work.

Limits: settings record Claude main model/effort but cannot switch the host. Role
helpers must use supported host controls. No account-wide model catalog is claimed.
The seal mechanically enforces execution order and prompt separation, not native
filesystem secrecy: an SDK with shared filesystem access could read host records.
The Phase 1 instructions prohibit that; stronger adversarial isolation needs host
support. Do not advertise the plugin as a security boundary between both models.
Transcript references do not protect against the host deleting its originals;
retain/export those with the host's supported controls. Private registry capacity
is bounded and never silently evicts history. Existing checkpoints and archived
thread IDs are retained on failed continuation; recovery must not invent ownership.

Mechanism refinements: settings do not create branches or block unrelated dirty
work. Trial isolation is an explicit execution step. Fabex discussion reporting
uses its bundled read-only SQLite adapter, never the configured add-on executable;
the add-on also exposes its own read-only reports. Chat-reference exports are
private named folders with stable milestone IDs; renaming does not delete older
reference exports or provider transcripts. No automatic retention deletion ships.
