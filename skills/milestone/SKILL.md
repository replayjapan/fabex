---
name: milestone
description: View milestone/chat associations or select a named milestone under owner authorization, preserving earlier threads.
disable-model-invocation: true
---

With no arguments run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs milestone`.
An owner-typed `/fabex:milestone <name-or-id>` issues a grant; apply the exact
`settings apply --grant <id>` supplied by the hook. Finish the current two-phase
cycle before switching. No thread or project file is deleted by switching.

Before leaving a milestone, have its Codex thread draft a bounded handoff: owner
goal and constraints, accepted decisions, remaining work, current files/branch,
test evidence and retained resources. Claude checks it against the original
requirements and current artifacts in reconciliation. Save it with
`control.mjs milestone handoff --review <completed-phase2-id> '<handoff>'`.
Use original documents for details; a summary is not a substitute for archives.

For a long chat, prefer native compaction. A repeated-compaction count is a
review signal, not an automatic restart. After reviewing the handoff and finishing
both phases, `control.mjs milestone rotate --review <id>` preserves the predecessor
as a linked part and seeds the successor. If startup fails, preserve both records
and report recovery; never loop through fresh threads. Never rotate mid-cycle.
Check current branch/files when returning; chat history does not restore code.

The owner can select `/fabex:milestone restore-part=0` to reconnect an archived
part of this milestone. The named grant is required; current history is preserved,
not overwritten. This restores chat continuity, never files, modes or permissions.
Revalidate remaining work before arming continuation. View private state through
settings/status to identify the archived part; do not guess from a filename.
