---
name: settings
description: View project defaults and current-session model, role, milestone and optional usage settings; apply only owner-selected changes.
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs settings --session <ownerSessionId-from-context>` to show effective
values and their sources. Viewing needs no grant. The spelling in Claude Code is
`/fabex:settings`; never claim a different spelling is installed.

An owner-typed command with arguments mints a grant containing those exact
arguments. Run the `settings apply --grant <id>` command supplied by the hook;
do not reconstruct or expand the request. Arguments are whitespace-separated
`key=value` assignments plus `scope=session` (default) or `scope=project`.
For example `roles.implementation.executor=claude scope=session`.
Use `key=inherit` to remove an override. Saving project defaults must be explicit.
Quote values containing spaces, for example `usageTracker.path="/absolute/path with spaces/track"`.

The current main Claude model is host-managed. A requested preference is not
proof it is applied; verify host `/model` and effort support. Codex partner
preferences are passed into the SDK. Account model availability is host-validated,
not inferred from a static list. Do not silently substitute a model.

Role preferences do not waive discussion, sandbox or destructive-action rules.
For a coding trial use a reviewed isolated worktree/branch when appropriate,
preserve dirty work, and separately isolate database effects. Settings do not
create a branch or reset data. Only one source author at a time.

Usage tracking is optional. Inherit follows the project setting; Off means no
Fabex integration calls or normal-reply reminders. Independently installed global
collectors are not uninstalled by this toggle. No installation or publication is
implied by editing a setting.
