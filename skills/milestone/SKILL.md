---
name: milestone
description: View milestone/chat associations or select a named milestone under owner authorization, preserving earlier threads.
disable-model-invocation: true
---

With no arguments run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs milestone`.
An owner-typed `/fabex:milestone <name-or-id>` issues a grant; apply the exact
`settings apply --grant <id>` supplied by the hook. Finish the current two-phase
cycle before switching. No thread or project file is deleted by switching.

Before leaving a milestone, update the project's existing handoff with the
selected Documentation writer(s). Select `control.mjs role docs` before that
documentation cycle and follow the shared-document workflow in `jointly/SKILL.md`.
Both is the default: each partner reads the same file, contributes what it knows
in turn, and checks the final handoff against the requirements and artifacts.
Cover the owner goal and constraints, accepted decisions, remaining work, current
files/branch, test evidence and retained resources. Save a concise continuity
summary with the shared file's path and next step using
`control.mjs milestone handoff --review <completed-phase2-id> '<handoff>'`.
The next conversation reads that file; do not make another handoff document for
the new chat. Use original documents for details; a summary is not a substitute
for archives.

Conversation controls live in `/fabex:session`: view, start fresh or reopen saved conversations. Never tell the owner to create a milestone to start a new chat. Native compaction keeps the conversation; a fresh Claude chat starts a fresh Codex conversation by default, unless the project preference says continue. Historical `milestone rotate` and `restore-part` controls remain internal compatibility paths; use the session command in the human workflow.
