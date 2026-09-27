---
name: settings
description: View and choose models, Coding/Testing/Image review/Documentation responsibilities, and optional usage reports for a conversation, planned milestone or project.
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs settings --session <ownerSessionId-from-context>`
and show its human view: project and planned milestone, then Models, Who does
what, and Weekly usage. Do not expose internal configuration as extra menu
sections. A milestone is a stage in the owner's plan, never inferred from a new
chat or chat title. Viewing alone never changes a preference.

An owner-typed `/fabex:settings` starts a five-minute, single-change dialog grant.
`/fabex:settings tracking=on|off|inherit` starts at scope selection. The expansion
hook supplies exact `AskUserQuestion` questions. Offer them unchanged. The
PostToolUse hook validates each owner answer and supplies the next question or
final apply command. Back and Cancel are accepted through the host's Other input
as well as dedicated choices where shown. Do not choose for the owner, invent an
answer, apply intermediate selections, or apply after cancellation. Unknown host
payloads fail closed. The final dialog asks value and scope together; it is the
owner’s selection, with no additional confirmation. Both answers must be recorded.
Apply only its hook-confirmed `settings apply --grant <id>` command between
completed review cycles. Without a dialog, read `settings --json` and show only
the relevant command from `typedCommands` for the owner to type. Questions alone
do not authorize other changes.

An explicit owner command such as `/fabex:settings tracking=on scope=milestone`
applies directly through the exact grant command supplied by the expansion hook.
Do not reconstruct or expand arguments. `tracking` aliases `usageTracker.mode`; `roles.testing.executor|model|effort`
updates both testWriting and testRunning preferences together. Existing different
preferences remain intact until the owner chooses a combined value.
After applying, show the returned plain-language `summary`, then report effective state
and any installation or allowance setup help. Do not claim fresh readings from a toggle.
New assignments to `milestones.newChatMeansNewMilestone` are retired; stored
values stay readable and can be cleared with `inherit`.
Project defaults apply across milestones; milestone overrides survive new chats
and thread rollovers. Precedence is project, milestone, then session. Use
`tracking=inherit` with an explicit scope to remove its override. Other settings
still default to session scope; saving project defaults must be explicit.

Fabex locates the independent tracker automatically. Multiple installations need
an explicit choice; show the provided path commands and do not guess. A
`usageTracker.path` override remains available. Quote paths containing spaces.
Installation or collector setup requires an owner instruction, not a settings
view. Missing Claude allowance readings do not prove the collector is absent.

Models from configuration or recent SDK observations are suggestions, independent
of usage tracking. Provider validation occurs on use. The main Claude model is
host-managed. Task model/effort overrides apply to Codex working turns; the first
independent answer uses the partner model. Claude main task model/effort cannot
be switched by Fabex. Test-running assignment guides work, not exclusive tool
authorization. Both main partners retain independent review in joint work.

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
