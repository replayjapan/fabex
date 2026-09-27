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

An owner-typed `/fabex:settings` starts a five-minute grant for one atomic set of
changes. The expansion hook supplies exact `AskUserQuestion` questions. Pass the
whole questions array in one tool call: the host displays related questions as
clickable tabs. Never split them into separate calls or ask the owner to type
Back. Every screen has visible Cancel; Back is a button on follow-up screens.
Keep current leaves the existing/pending choice alone, even if scope changes.
No milestone scope is offered until the owner has named a stage of the plan.

The PostToolUse hook validates every answer and supplies the next screen or the
final apply command. More models/effort levels pages through the live catalog,
keeping pending choices. Task selection precedes the writer/scope tabs; Model
options opens model/effort tabs for that task. Claude uses its host controls;
with Both, the editable task model/effort are explicitly Codex's, never shared.
Navigation displays any pending changes. Apply saves them together; Cancel or
expiry saves nothing. Do not invent answers, options, or a partial apply. Apply
only the hook-confirmed `settings apply --grant <id>` between completed review
cycles. Unknown host payloads fail closed. Pre-upgrade dialogs must be reopened.
The tracking shortcut opens the tracking/scope tabs directly. Without a native
dialog, show only the relevant typed command from `settings --json` for the owner
to type. Do not request a confirmation after an already recorded Apply.

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

Model choices and supported effort levels come from the pinned Codex CLI's
`model/list` response for its current account. Saved names and usage history are
not an availability catalog. If lookup fails, show the supplied explanation and
retain preferences; do not invent fallback choices. Provider validation still
occurs on use, without substitution. Claude's actual model picker is its native
`/model` control, not a hard-coded Fabex list.

Documentation defaults to Both unless an explicit existing preference overrides
it. Follow the shared-document workflow in `jointly/SKILL.md`: both partners read
and update the existing handoff in turn, each contributing what it knows. No
private drafts, compulsory author sections or extra companion document are needed.
Both main partners retain independent review of the owner's request. Only the
selected Coding AI edits code, including test code and configuration. Documentation
access does not grant source edits; Testing responsibility does not change the
Coding selection. Explicit owner-named sub-agent exceptions remain available.

The current main Claude model is host-managed. A requested preference is not
proof it is applied; verify host `/model` and effort support. Codex partner
preferences are passed into the SDK. Account model availability is host-validated,
not inferred from a static list. Do not silently substitute a model.

Role preferences do not waive discussion, sandbox or destructive-action rules.
For a coding trial use a reviewed isolated worktree/branch when appropriate,
preserve dirty work, and separately isolate database effects. Settings do not
create a branch or reset data. Only one source author at a time; Docs Both updates the shared document in turn.

Usage tracking is optional. Inherit follows the project setting; Off means no
Fabex integration calls or normal-reply reminders. Independently installed global
collectors are not uninstalled by this toggle. No installation or publication is
implied by editing a setting.
