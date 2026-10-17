---
name: session
description: View, start fresh or reopen a saved Codex conversation without creating a project milestone.
disable-model-invocation: true
---

With no arguments, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs session --session <ownerSessionId-from-context>` and show the current and saved conversation IDs and titles in plain language.

The owner can type `/fabex:session fresh` or `/fabex:session reopen <saved-id>`.
Only apply the exact `settings apply --grant <id>` supplied by the owner expansion hook. A tool invocation cannot grant a change. Wait for the current review cycle to finish; never abandon it to switch. Keep every previous conversation. Reopen restores conversation context, never application files, settings or activity permissions. Revalidate archived open work before continuing; report a provider refusal to reopen rather than claiming success. Earlier archived parts can be reopened using their displayed thread ID.

New Claude chats start fresh Codex conversations by default. `/fabex:settings sessions` opens this preference; choose Whole project to change future chats. Resume, compaction and repeated startup events for a known chat keep its conversation. A conversation never creates a milestone. `/fabex:milestone` is only for optional named stages of the project plan.
