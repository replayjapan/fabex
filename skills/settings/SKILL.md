---
name: settings
description: View project defaults and current-session model, role, milestone and optional usage settings; apply only owner-selected changes.
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs settings --session <ownerSessionId-from-context>`
and show its human view, including tracking status, scopes, installation help and
other common choices. Use `--json` only when requested. Owner spelling is
`/fabex:settings`. Viewing alone never applies a setting.

An owner-typed bare `/fabex:settings` or `/fabex:settings tracking=on|off|inherit`
issues a five-minute, single-use selection grant. The expansion hook supplies the
exact `AskUserQuestion` questions. Offer them unchanged when that host tool is
available. Apply only after the PostToolUse hook confirms the owner's answer was
recorded, using its `settings apply --grant <id>` command. Never invent a response,
select an option yourself, or apply after cancellation. Unknown host payloads fail
closed. Without a dialog, show the printed explicit commands for the owner to type.
Questions alone do not authorize mutations outside their recorded choices.

An explicit owner command such as `/fabex:settings tracking=on scope=milestone`
applies directly through the exact grant command supplied by the expansion hook.
Do not reconstruct or expand arguments. `tracking` aliases `usageTracker.mode`.
After applying, view settings again and report the selected scope, effective state
and any installation or allowance setup help. Do not claim fresh readings from a toggle.
Project defaults apply across milestones; milestone overrides survive new chats
and thread rollovers. Precedence is project, milestone, then session. Use
`tracking=inherit` with an explicit scope to remove its override. Other settings
still default to session scope; saving project defaults must be explicit.

Fabex locates the independent tracker automatically. Multiple installations need
an explicit choice; show the provided path commands and do not guess. A
`usageTracker.path` override remains available. Quote paths containing spaces.
Installation or collector setup requires an owner instruction, not a settings
view. Missing Claude allowance readings do not prove the collector is absent.

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
