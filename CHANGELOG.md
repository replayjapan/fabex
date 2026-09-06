# Changelog

## 1.7.2 - 2026-09-06

### Why we made this change

A phone-photo test exposed a missing permission: Remote Control supplied a local upload reference outside Fabex's permitted attachment roots, so Codex's independent turn received text only.

### What it gave us

Session-scoped phone-photo attachments using the existing SDK image transport, with visible validation failures and bounded delivery status. No general filesystem write permission, new transport, model change, or Git-delivery authority is added.

### Tradeoffs

Fable must forward the current message's host-supplied reference without inspecting the image; the prompt hook does not receive that host note. Session membership is validated, but same-message provenance and omitted host attachments cannot be mechanically proven. The host may still show photos to Fable directly. A completed image-bearing SDK turn confirms transport, not the accuracy of visual review. Live phone retesting remains required.

### Changes

- Permitted validated images only under the hook-recorded session directory within the Claude config directory's uploads folder, honoring `CLAUDE_CONFIG_DIR`. Missing/ambiguous evidence, sibling sessions, and symlink escapes fail closed; no upload directory scanning or broader write allowance.
- Raised the per-image limit to 16 MiB, retaining the six-image limit and existing supported formats. Invalid attachment submissions fail as a whole and never queue a text-only fallback.
- Added per-path selection/failure output and path-free indexed submission/delivery metadata. `delivered` requires an image-bearing SDK completion event. Schema 12 preserves schema-11 state losslessly; historical delivery remains unknown and the live-runner migration gate stays intact.
- Updated the phone-forwarding and status instructions and added regressions for session boundaries, size, symlinks, failure reporting, image-access guards, delivery, and migration.

## 1.7.1 - 2026-09-06

### Why we made this change

Image review should belong to Codex, with Fable consuming its description rather than inspecting screenshots itself. Read-only routes also need narrowly scoped research and an optional configured-model image-description helper.

### What it gave us

Extension-based image access restrictions, explicit mode-command attachments in independent Phase 1, and read-only research/delegation without changing modes. Canonical continuity, independent-first sequencing, owner-only mode grants, and Git delivery authority remain unchanged.

### Tradeoffs

The guard recognizes image references by extension; it cannot identify disguised image content or prevent the host from placing images directly in Fable's context. The requested helper model is explicit, not proof of the model served or its price. Selected files must remain available until execution; validation failures retain the unused mode grant and owner text.

### Changes

- Made Codex the default image reviewer; Fable uses Codex's description or an explicitly requested operational helper. Denied main-session and non-operational image references through Read, Bash, MCP, and image-URL WebFetch while preserving validated attachment submissions.
- Permitted only the configured operational model with a data-only image-description envelope, plus WebSearch, HTTP(S) WebFetch, and the claude-code-guide agent in discussion/ask. Recovery restrictions and read-only project/Git guards remain intact.
- Added explicit `attach: <absolute path>` lines in mode-command text to Phase 1 attachments without changing the verbatim owner message. Mere path mentions are not attachments. Kept existing image bounds and schema 11.
- Added a portable `.claude/` ignore rule; retained local settings. Updated the image-review instructions, complete relay guidance, and regression tests.

## 1.7.0 - 2026-09-06

### Why we made this change

Owner-approved discussion improvements must let Codex see supplied images and let the owner read Codex's exact answers, rather than a blended summary. Structured reviews make evidence, uncertainty, and disagreement explicit.

### What it gave us

Image-enabled independent and reconciliation turns on the same canonical SDK thread, bounded structured findings, and a ready-to-paste full-answer relay checked at Stop. Codex-only project writing and operational-only Git delivery remain unchanged.

### Tradeoffs

Images are sent to Codex and may remain in SDK history; Fabex erases only its own terminal operation paths. Attachment authorship and UI/spoken delivery are not mechanically verifiable. Structured output can fail validation and falls back to text with a warning. Relay matching normalizes whitespace; the owner-requested recovery escape prevents an interrupted cycle trapping the session. Pending undelivered answers consume bounded state capacity. Permission profiles were not adopted because they do not compose with the existing explicit sandbox selection.

### Changes

- Added up to six approved absolute image paths per phase, at most 8 MiB each, checked against workstream/external roots and resolved symlinks on submission and execution. Terminal operations erase paths; image bytes never enter Fabex state.
- Requested a phase-specific SDK output schema for both participants; preserved the complete `answer` plus bounded evidence, assumptions, uncertainties, disagreements, recommendations, changed files, and test exit codes. Single-participant output remains free text; malformed output produces a visible fallback warning.
- Added complete labeled `relayBlock` output and Stop checks for missing/truncated answers, with per-session acknowledgement and cycle-level `recover abandon` waiver. Protected pending relays and linked phases from pruning. Schema 11 migrates schema 10 losslessly without retroactively requiring old answers to be relayed; the live-runner migration gate remains intact.
- Documented the permission-profile compatibility review without adding an ineffective deny-path key. Kept SDK/CLI 0.153.4, native sandbox selection, subscription authentication, and thread continuity unchanged.
- Recorded the reported host ARGUMENTS rewrite failure as a platform limitation; no claim of early Fable blindness or new rewrite mechanism.

## 1.6.2 - 2026-09-06

### Why we made this change

The SDK upgrade and live dogfood exposed missing speaker attribution, host-added arguments, and waits that stopped during safe migration deferral.

### What it gave us

Explicit model-family labels and bounded usage metadata, with reliable waiting while an old runner finishes. Existing independent-first, mode authorization, thread continuity, and security guarantees remain intact.

### Tradeoffs

The host `updatedInput` rewrite is a candidate requiring a live post-reload probe; early Fable visibility remains a platform limitation if ignored. The `fabex` thread source is not a guarantee of Desktop invisibility. Configured model identity is not served-model verification, and the upgraded CLI's unset-model default may change.

### Changes

- Pinned SDK and CLI runtime to 0.153.4, retaining both lockfiles and existing subscription authentication. Diagnose identifies the model configuration source without changing the owner's model selection.
- Added `Claude (Fable):` / `Codex (Astra):` family-only labels with plain-speaker fallbacks; SessionStart records bounded Claude model metadata. Schema 10 migrates prior state losslessly.
- Added a mode-expansion `updatedInput` candidate that removes the host arguments suffix or uses the packaged skill body, while retaining exact owner text privately for Phase 1.
- Retried `migration-deferred` in bounded controller waits; permitted non-mutating host monitoring during migration while preserving Bash/write restrictions.
- Adopted creation-only `threadSource: "fabex"`, bounded per-operation input/cached/output usage, and opt-in `persistent` effort. Deferred `outputSchema` scope/parity output and `local_image` screenshot relay to 1.7; no app-server transport change.

## 1.6.1 - 2026-09-05

Fabex 1.6.1 is a focused patch for three regressions found while dogfooding the 1.6.0 two-phase workflow. It preserves independent-first sequencing, owner-only mode grants, canonical thread continuity, Codex-only project writing, and the existing fail-closed guards.

- Restored mode-command message forwarding without interpolating owner text into Fable's expanded skill prompt. `UserPromptExpansion` now captures same-line or multiline arguments byte-for-byte in the private grant; the atomic mode command changes mode first, then creates the route-appropriate partner operation. No-argument commands remain mode-only, and grants or text are retained on failure.
- Added schema 9 owner-selected-mode durability. Recovery no longer defaults to work: abandon, missing-thread, lock, transaction, resume, and orphan paths preserve the proven owner-selected route, while unknown history fails closed to discussion and requires a new owner command. Runner claim and operation claim now retry transient state-lock contention with bounded backoff.
- Made owner-authorized mode transitions supersede an unreconciled Phase 1. The stored independent result is retained and marked interrupted, Stop no longer blocks on it, queued work is cancelled, active work is stopped before the transition applies, and grant expiry pauses while that stop completes. Switching to discussion therefore cannot release later workspace-write work from the interrupted cycle.

## 1.6.0 - 2026-09-05

### Why we made this change

Long-project dogfooding exposed two steering failures. Codex received Fable's current framing in the same prompt as the owner message, so it could not form a genuinely independent first reading. Separately, Claude or another AI executor could invoke the same Fabex mode command used by an owner-typed slash command. Stable Claude Code hook events also offered a safer way to verify owner-visible context and observe phase completion without adopting the preview function-hook API.

### What it gave us

- An independent Phase 1 containing only the authoritative turn header, the owner's message, and the previous owner-visible Fable reply, followed by a separately linked Phase 2 for convergence.
- A stored, immutable Phase 1 result and owner-message digest, with an owner-cycle FIFO barrier that prevents later work from passing an unfinished Phase 2.
- Owner-only route and participant changes through a short-lived, session-bound, single-use mode grant issued by `UserPromptExpansion` and consumed atomically by the mode command.
- Digest-only verification of owner prompts and owner-visible replies, plus bounded operational-agent, compaction, and wake-watcher metadata.

### Tradeoffs we accepted

- Both-participant owner cycles now use two SDK turns, increasing latency and Codex usage in exchange for independent-first review and explicit convergence.
- Mutual blindness is not promised: Fable may read Codex's stored Phase 1 before writing its current response. The owner's goal is for Codex to catch Fable's mistakes, so only Codex's first reading is isolated.
- `asyncRewake` is optional and remains backed by blocking `wait`. Claude Code starts a process for each asynchronous hook invocation, so Fabex deduplicates one watcher per project and retains process and RAM behavior as live Beta gates.
- Hook payload behavior and activation must be verified after plugin update, forced reload, and session restart. Repository tests do not prove live host activation.

### Changes

- Replaced the one-turn both-participant envelope with strict JSON `independent` and `reconcile` phases. Unexpected fields, trailing Fable notes or framing, mismatched owner messages, invalid parents, and reused Phase 1 results fail closed.
- Prefixed both new and resumed prompts with an authoritative phase-aware `FABEX TURN` header. A fresh-thread recovery checkpoint is supplied through route-neutral developer configuration so it cannot trail the Phase 1 envelope.
- Added a durable Phase 2 barrier, whole-cycle Stop blocking, explicit abandonment recovery, and phase-aware cancellation while preserving the exact canonical Codex thread.
- Added stable `UserPromptSubmit` and `Stop` evidence hooks that retain SHA-256 digests, sizes, timestamps, and session IDs only. Raw owner messages, replies, transcripts, thinking, tool logs, and compaction summaries are not copied into evidence state.
- Added `UserPromptExpansion` grants for owner-only mode changes. Grants are bound to session, project, route, and participants, expire after one minute, and are consumed once; main Claude, subagents, and direct Codex commands cannot change modes without one.
- Added a deduplicated `PostToolUse` `asyncRewake` watcher while retaining `controller wait` as the deterministic fallback.
- Added exact operational-agent lifecycle records from `SubagentStart`/`SubagentStop` and timestamp-only compaction records from `PostCompact`.
- Added a live migration gate: hooks and reads report `migration-deferred` and leave the previous schema untouched while a live runner owns an active operation.
- Filtered task, system, reminder, and local-command notification prompts from owner evidence. Added a private eight-entry digest-only sidecar so legitimate interleaved prompts remain verifiable without changing schema 8 or retaining prompt text.
- Restricted built-in `node --test` verification to automatic discovery or explicit paths inside the configured repository/workstream. External paths and extra Node flags remain denied unless exactly configured.
- Made cancellation detect a dead runner behind a `working` operation and enter recovery-read-only with an unknown outcome. `recover abandon` can perform and then reconcile the same sanctioned transition without a new submit.
- Added schema 8 with lossless schema-7 migration for phase linkage, context evidence, mode grants, operational lifecycle, compaction metadata, and watcher ownership.
- Added named regressions for strict phase separation, cycle ordering, digest privacy, single-use grants, Stop/recovery behavior, hook metadata, watcher deduplication, schema migration, stable-event registration, and direct mode-command denial.

## 1.5.2 - 2026-09-04

Fabex 1.5.2 is a focused pre-submission packaging and delivery-guard release. It keeps the 1.5.1 state schema, canonical thread, FIFO controller, Codex-only project writing, operational-only Git delivery, and Beta dogfood gates unchanged.

- Added `package-lock.json` alongside the contributor `pnpm-lock.yaml`, with both locking `@openai/codex-sdk` and its CLI dependency to 0.149.0. Claude Code can now install cached marketplace dependencies automatically with `npm ci --ignore-scripts`; marketplace users no longer need a manual pnpm step.
- Replaced the stale unassigned-marketplace wording with the public `replayjapan/fabex` install flow, retained local-checkout instructions, and documented validation plus the Anthropic Console submission form.
- Hardened shell argv parsing for the verified `fabex:fabex-operational` delivery executor so escaped quoted content, parenthesized commit bodies, and quoted multiline commit messages remain direct protected Git commands. The same commands stay denied to the main session and every unverified executor.
- Made safe command segmentation treat backslash-newline as whitespace inside one logical delivery command, matching argv tokenization. Command substitution, heredoc-built commit messages, and trailing raw shell commands remain denied.
- Added named regressions for automatic-install lock parity, marketplace/submission documentation, and both reported Git commit-message forms. No state schema or persisted shape changed.

## 1.5.1 - 2026-09-04

Fabex 1.5.1 is a focused reliability and least-privilege release driven by live long-project dogfooding. It preserves canonical Codex continuity, FIFO execution, Codex-only project writing, operational-only Git delivery, fail-closed guards, and verbatim owner-visible context sharing.

- Added argv-token `guard.allowedCommandPatterns` with exact arguments and a one-token `*` wildcard. Relative Node script arguments resolve against the configured repository root and cannot escape the workstream. Executable-only `allowedCommands` remains compatible but now produces an explicit broad-authority warning in config and diagnose.
- Recognized safe named package-manager verification scripts including `test:<name>`, `check`, and `run <name>` forms while continuing to reject snapshot-update, write, fix, force, and similar mutation flags.
- Unified quote-aware command composition. Every pipeline, `&&`, or `;` segment is independently allowlisted; quoted alternation remains data, safe Fabex status pipelines work, and mutating segments, output `tee`, substitution, or hidden Git delivery fail closed.
- Restricted Bash scratch output to one absolute target outside the workstream and inside configured `externalWriteRoots`. Quoted heredocs and simple single-target redirects may append only within those roots; defaults cover the OS temporary directory, Claude project memory, and session scratchpads.
- Added exact read-only help probes for control, checkpoint, and controller usage.
- Added bounded lock-contention waiting with exponential backoff for read-only state access. Status, diagnose, config, checkpoint reads, controller status/result, and blocking wait tolerate brief runner locks without deleting or stealing them; timeouts expose only safe lock metadata.
- Replaced static diagnose activation prose with source/registry comparison, hook validity, reload certainty when knowable, and the last successfully recorded Fabex turn/version. Activation remains explicitly unknown when runtime evidence is insufficient.
- Made both-participant submissions explicit with `ownerMessage`, `claudeReplyStatus`, and conditional `claudeReply`; any provided owner-visible Claude reply is validated before queueing. Claude Code does not provide a sufficiently reliable owner-visible-only prior reply contract, so Fabex reports verification unavailable and rejects ambiguous envelopes without capturing transcripts.
- Separated captured and live repository fingerprints in status, added capture/computation timestamps, and warns without mutation when they differ. Successful turns atomically refresh checkpoint time, thread metadata, both stored fingerprints, and the recorded Fabex version.
- Reduced default status history to active/queued operations plus the last three terminal records; added `status --all` and `status --brief`.
- Fixed guard ordering so validated controller-submit and checkpoint heredoc bodies may quote protected Git text without being misclassified as shell delivery commands; only their exact executable header is authorized.
- Added schema 7 with lossless schema-6 migration, named regressions for every 1.5.1 finding, and a nested-repository dogfood fixture. No delivery authority or project-write restriction was relaxed.

## 1.5.0 - 2026-09-04

Fabex 1.5.0 hardens long-running projects. Codex dogfood feedback identified the first twelve context, checkpoint, authority, repository, network, version, and regression gaps; Claude identified the blocking-wait and substring-guard failures. Integration then exposed the stale resumed-thread instruction and live-plugin update hazards.

- Made context sharing bidirectional: owner-visible Claude replies and owner messages use a shared verbatim envelope; private reasoning and tool logs remain excluded.
- Added checkpoint capacity, export, atomic array replace/compact, and atomic five-field snapshot controls under the unchanged 48 KiB recovery budget. Full arrays now report their exact capacity instead of a generic invalid-state error, and notification-shaped text is rejected.
- Added checkpoint `updatedAt`, per-field timestamps, and bounded warnings for empty, contradictory, stale, and unavailable-fingerprint state.
- Moved executor exceptions from regex-scanned decision prose into schema-v6 structured state, with one-time legacy migration and explicit authorize/reconcile controls.
- Repaired task status transitions so recovery abandonment, new submissions, successful completion, and non-recovery failures all have documented exits.
- Added project-only `project.repositoryRoot`; fingerprinting never auto-selects among nested repositories, and the resolved in-workstream repository is passed to the SDK as an additional directory.
- Replaced normal-route Claude write behavior with file, Bash, verification, and read-only MCP allowlists covering main sessions and subagents. Safe read/verification pipelines are accepted when every segment is allowlisted, while non-mutating host orchestration tools defer and remain subject to the same per-executor mutation guards. Extended the operational-only Git delivery lane through add, commit, tag, merge, rebase, cherry-pick, push, send-pack, Git LFS push, and `gh`.
- Added project-configurable `models.codex.networkAccessEnabled`, off by default and effective only for workspace-write turns. Fabex never selects `danger-full-access`.
- Added blocking `controller.mjs wait`, exact invoked-script parsing, and installed-plugin registry diagnostics with upgrade guidance.
- Fixed stale turn authority on resumed SDK threads. Developer instructions are now route-neutral; every first or resumed prompt begins with an authoritative `FABEX TURN` header. Threads created by 1.4.0 during discussion can retain the old developer message, so the per-turn header is the compatibility fix.
- Added regression coverage for all reported failures and retained compatibility with the intermediate schema-v6 state produced during development.
- Documented that the runner, hooks, and guard execute from the live plugin tree. Schema-changing development must occur in a copy and be swapped only after the active runner exits; status polling pauses during that swap. A future migration gate should refuse live migration while an active runner owns an operation.

## 1.4.0 - 2026-08-23

### Why we made this change

The synchronous MCP transport shipped in 1.3.0 lasted one day. Dogfooding confirmed two transport defects rather than a theoretical preference: Claude Code backgrounds a long MCP call at roughly 120 seconds, and the PostToolUse payload can omit the `structuredContent` the recorder required even when a fast Codex turn succeeded. Together they produced five orphaned threads. The same synchronous call also created a black-hole experience in which genuine progress was unavailable for minutes. Keeping MCP would have meant building more recovery around a boundary that could not reliably record success.

The official TypeScript Codex SDK exposes the primitives Fabex actually needs: `runStreamed()`, persisted thread IDs, `resumeThread()`, per-turn sandbox settings, and abort signals. Replacing MCP also restores mechanical read-only discussion/ask turns without splitting the continuous thread.

### What it gave us

- One exact canonical SDK thread for every joint-mode owner message, cold-resumed across controller and Claude restarts.
- Immediate operation IDs, durable FIFO queuing, genuine `working`/`command`/`tests`/terminal lifecycle status, and cancellation without intentionally discarding continuity.
- Per-turn `workspace-write` implementation and `read-only` discussion/ask sandboxes on the same thread.
- A structured recovery checkpoint whose complete seed has a hard 48 KiB limit, replacing the raw owner-goal list that could exceed the 256 KiB prompt boundary.
- No credential or billing expansion: Fabex passes no API key and relies on the existing Codex CLI ChatGPT subscription sign-in.

### Tradeoffs we accepted

- The controller is a small detached local Node job runner with durable state. That adds a process and queue lifecycle that must be dogfooded for orphaned processes and RAM accumulation.
- SDK exec-source threads are expected to stay out of Codex Desktop's default Recents, but that remains an observed product behavior and a hard Beta release criterion rather than a platform guarantee.
- v1 serializes whole owner turns and does not steer an active turn. A queued correction waits for the current operation to complete or be cancelled.
- A confirmed missing SDK session requires explicit recovery before a checkpoint-seeded replacement. Ambiguous failures never create a replacement automatically.
- The plugin now has an installed Node dependency. The SDK is pinned by `package.json` and `pnpm-lock.yaml`; `node_modules` is installed locally and is not committed or bundled.

### Changes

- Replaced `.mcp.json`, the MCP adapter, synchronous result hooks, begin-authorized tools, and MCP recovery paths with `scripts/controller.mjs` and the official `@openai/codex-sdk` 0.149.0.
- Added a durable serialized operation queue. `submit` returns a UUID immediately; `status`, `result`, and `cancel` are exact guarded controller entry points.
- Consumes SDK streaming lifecycle events without exposing reasoning or command output. First-event `thread.started` IDs are verified on every turn; continuations must match the persisted canonical ID exactly.
- Reconstructs the same thread with `resumeThread(exactId, options)` on every execution and reapplies `developer_instructions`, `compact_prompt`, model settings, working directory, approval policy, and per-turn sandbox.
- Added AbortSignal cancellation for active turns and direct cancellation for queued turns. Terminal operations erase their retained raw owner message.
- Added schema v5 with controller ownership, queue lifecycle, SDK transport metadata, and the structured checkpoint. Migration from 1.3.0 schema v4 preserves its exact canonical thread ID and converts its bounded checkpoint; older companion-era IDs remain retired.
- Detects the SDK's observed `Session not found for thread_id: <id>` text. Only an explicit exact-condition recovery action clears the missing canonical ID for checkpoint-seeded replacement.
- Enforces the full 49,152-byte recovery-seed limit, including title and framing—not merely per-field limits.
- Removed MCP gating while preserving exact controller gating, Claude-only denial, Claude main-session Write/Edit/NotebookEdit denial, executor exceptions, and the plugin-scoped operational-agent GitHub push guard.
- Added Beta markers to README and plugin/marketplace descriptions; live installation, Desktop visibility, process accumulation, and RAM dogfood remain pending.
- Updated all mode, continuity, restart, progress, installation, dependency, privacy, retention, recovery, and activation documentation for the SDK transport.

## 1.3.0 - 2026-08-22

### Why we made this change

The top priority is continuity during a working session: Codex should retain the same conversation memory when the owner moves between work, discussion, and ask modes. The companion design used separate threads and app/companion hydration, which created Codex Desktop session clutter and, in the owner's real workflow, contributed to memory growth of roughly 60 GB and a machine crash. Returning to MCP lets Fabex meet the in-session continuity priority with a much simpler design and avoids over-engineering restart behavior that is not the primary goal.

### What it gave us

- One continuous Codex thread across every Codex-including mode, with the exact returned `threadId` verified on every continuation.
- A smaller plugin with no companion discovery, background-job store, sibling-thread coordination, polling, result fetching, re-sync tasks, or checkpoint-and-refresh machinery.
- No new ordinary Codex Desktop session clutter in current observed app behavior, while keeping that behavior explicitly outside Fabex's guarantees.
- No added credential, API-key, billing, or billing-guard surface; Fabex uses the installed Codex CLI's existing authentication.

### Tradeoffs we accepted

- Background execution, status/cancel controls, and the companion job audit trail are gone. A long synchronous Codex turn can now run silently for many minutes with no progress display.
- Restart-durable continuity is no longer a primary guarantee. Reattachment is best-effort, and a definitively unavailable thread can be replaced once from the bounded checkpoint; that seed cannot recreate unrecorded reasoning or the full transcript.
- Discussion and ask modes are behaviorally read-only instructions on the same continuous `workspace-write` thread, not mechanically separate read-only sandboxes.
- The MCP thread's current invisibility in ordinary Codex Desktop recents is app behavior, not a guarantee; Fabex cannot promise future Desktop visibility or resource behavior.

### Changes

- Replaced the Codex companion background-task transport with the installed Codex MCP server and its synchronous `codex` and `codex-reply` tools. Removed companion discovery, job lifecycle, status polling, result fetching, resume-candidate inspection, and re-sync task creation.
- Consolidated the former primary and write siblings into one canonical `workspace-write` Codex thread that remains continuous across every Codex-including Fabex mode change. Mode changes no longer create Codex threads.
- Added mechanical continuation verification using the `threadId` returned in MCP structured content. Calls remain serialized per workstream; missing or mismatched IDs, interruptions, timeouts, and ambiguous outcomes fail closed.
- Changed restart recovery to one lazy, best-effort exact-ID `codex-reply` attempt. A definitively unavailable thread permits at most one bounded-checkpoint-seeded MCP replacement; ambiguous failures never create replacements automatically.
- Migrated schema v1-v3 state atomically to the single-thread schema while retaining bounded owner goals, accepted decisions, current status, and repository fingerprints. Stored companion thread IDs and operations are retired.
- Removed caller-supplied thread completion and all direct companion result-fetch paths. MCP results are accepted only by the PostToolUse hook from the synchronous response carrying the structured thread ID.
- Updated the route guard to validate the exact Codex MCP tools and canonical thread ID, deny MCP use in Claude-only modes, and hard-deny Claude main-session Write/Edit/NotebookEdit in normal mode. The owner-named recorded executor-exception escape, operational-executor authority, and GitHub push protections remain in force.
- Corrected Claude-only capture semantics: raw Claude-only questions and answers are neither relayed to Codex nor placed in its restart seed. Owner-approved decisions and relevant current status may still enter the bounded checkpoint.
- Added bounded pruning of terminal operation records while preserving unresolved recovery records and the continuity checkpoint.
- Kept Sonnet as the configurable operational-agent default and now requires the selected model to be passed explicitly when creating the agent. Fabex does not promise that the configured model is always cheaper.
- Kept credential handling outside Fabex: the plugin does not request, store, inspect, sanitize, or configure credentials.
- Retired the repeated paired benchmark as a release blocker. Existing measurements remain informational; repeated paired runs are required only before publishing new quantitative savings claims.
- Updated installation, privacy, retention, continuity, and marketplace documentation for MCP. Restart continuity is best-effort, MCP visibility in Codex Desktop is not guaranteed, and discussion mode is behaviorally read-only but cannot mechanically remove write capability from the continuous thread.
- Added the stable `Fabex partner — <project> — continuous session` first-line convention.
- Repository implementation is complete, but activation, exact live tool exposure, same-thread mode transitions, interruption handling, and cross-restart behavior remain pending the owner's future plugin reload.

## 1.2.0 - 2026-08-21

- Added persistent primary and write Codex threads, bounded checkpoints, repository fingerprints, per-workstream serialization, mechanical resume-ID verification, and fail-closed mismatch handling.
- Migrated schema v1 and v2 state automatically and atomically to schema v3; existing recorded partner threads become primary threads and are checkpoint-seeded on session re-sync.
- Made every owner message in every both-participant mode consult Codex, including greetings and lookups. Latency and Codex usage increase by design, per owner requirement; single-AI modes remain the only exclusion.
- Replaced the former view-isolation wording with an auditable current-turn opinion-blind protocol while retaining shared owner-visible history and prior converged decisions.
- Added stale-repository warnings, status-visible thread metadata, owner-offered checkpoint-and-refresh guidance, and outermost-owner workstream-root resolution that prevents abandoned nested state from shadowing an ancestor workstream.
- Added the permanent owner-mandated partnership-parity watchdog: every Codex prompt carries the owner's words verbatim and invites scope and parity flags, which Claude must relay unedited.
- Fixed mid-session and interleaved primary/write continuity by creating session re-sync threads through the companion background-task store and inspecting its resumable candidate before every `--resume-last`. An absent or sibling-mismatched candidate now routes to one visible, checkpoint-seeded atomic replacement before any prompt launch; post-launch confirmed-missing recovery remains exact-condition-only, while ambiguous inspection/runtime failures and returned-ID mismatches remain fail-closed.
- Codified executor authority: Codex performs all project file edits, `fabex-operational` performs every GitHub or `gh` sequence, and Claude coordinates without directly performing either class of work. Owner approval never overrides the prescribed executor; exceptions require an explicitly named alternate plus bounded authorization and reconciliation records.
- Added a fail-closed push guard that denies main-session, alternate-agent, and ambiguous-identity `git push`, `git send-pack`, Git LFS push, and `gh` operations while allowing only a verified, plugin-scoped `fabex:fabex-operational` subagent identity; the bare agent type remains denied.
- Required emergency or off-books companion recovery to be recorded as a named executor exception and reconciled into the persisted Fabex checkpoint afterward.
- Recorded the delivery deviation for commit `f11e7c7`: Claude pushed it directly; the contents remain valid and history is not rewritten.

## 1.1.0 - 2026-08-20

- Added `workClaude`, `discussionClaude`, and `discussionCodex`, plus participant selection across the eight supported work, discussion, and ask modes.
- Changed `/ask` and `/discussion` to consult both Claude and Codex. This can add latency and consumes Codex usage compared with 1.0.x; use the Claude- or Codex-specific variants when desired.
- Added canonical mode labels, configurable reply badges, and an opt-in deterministic read-only status-line renderer.
- Migrated persisted state automatically and atomically from schema v1 to v2, adding `participants` and one-shot `returnTo` state without sending existing installs into recovery.
- Made ask-once restore the exact prior persistent route and participants instead of always returning to normal joint work.

## 1.0.1 - 2026-08-20

- Strengthened normal-session operational delegation with an imperative rule for image and screenshot inspection, GitHub and `gh` command sequences, and log-dump analysis.
- Documented which routing protections are mechanically enforced and which collaboration behaviors remain advisory.
- Reworded routing, opinion separation, delegation, and model-compatibility claims to distinguish deterministic controls from model-dependent behavioral compliance.

## 1.0.0 - 2026-08-19

- Initial public release.
- Added separated Claude and Codex views with Codex-led implementation.
- Added normal, discussion, ask-once, and recovery-read-only routing.
- Added transactional state, layered configuration, recovery controls, and public documentation.
- Documented the final single-run implementation benchmark: the two-lane design used 2,224 Claude output tokens versus solo Claude's 3,919 (about 43% fewer), while using more cache-read tokens; Codex-side usage remains separate real spend, and the release gate remains the median of repeated paired runs.
