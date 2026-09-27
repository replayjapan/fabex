# Fabex 1.10.6 authoring review

The owner-selected Coding AI is the only main code editor. This applies equally
to Claude and Codex and includes test code, scripts and configuration. Docs Both
permits collaborative handoffs and plans; it does not transfer code ownership.
Existing explicitly owner-named sub-agent exceptions keep their scope. Old
main-session edit exceptions cannot bypass Coding; their records remain readable.

Automated checks cover:

- Docs Both permits ordinary text-document edits, but denies a non-coding Claude
  source, test or configuration edit through direct file tools and recognized
  shell/MCP writes. A code file inside docs/ is still code.
- Unknown targets, executable MDX, agent instruction files and linked targets do
  not receive the text-document exception.
- Selecting Claude for Coding allows its bound main session to edit code across
  task roles. Selecting Claude for Testing alone does not grant that permission.
- A named sub-agent exception grants only that executor the recorded scope and
  does not override discussion mode. Other sub-agents remain excluded.
- Codex receives the same assignment rule. When Claude owns Coding, non-document
  Codex turns request a read-only sandbox; its prompt and recorded execution
  envelope show that actual sandbox.
- Content snapshots flag non-document additions, deletions and modifications,
  including already-dirty files. Controller warnings survive reconciliation and
  cannot be omitted from the successful-turn relay. Failures and cancellations
  retain the warning in their result too.
- Testing shows who runs checks and which Coding AI writes test code.
- The existing shared-handoff workflow continues to update one file in turn.

## Remaining enforcement limitation

Codex document-writing turns still request workspace-write so it can update the
shared file directly. Their document-only boundary is instructional, not a native
file-type restriction. Claude's shell guard likewise does not prove arbitrary
program effects. This patch must not be presented as complete symmetric technical
enforcement of source ownership.

The current SDK launch uses read-only or workspace-wide writes. Native permission
profiles offer finer paths, but require integration and verification rather than
silently mixing them with the existing sandbox setup. See the official
[permission guidance](https://learn.chatgpt.com/docs/permissions).

Live verification of native permission enforcement is still needed. The local
nested macOS sandbox probe was refused by the host; no attempt was made to bypass
that restriction. Post-turn detection does not close the native prevention gap.

The audit checks tracked and non-ignored untracked Git files, or project files
excluding Git metadata and node_modules outside Git. It does not follow links,
attribute writes to a process, cover ignored/external files, or detect edits
reverted within a turn. File-count/size/read limits produce an incomplete-check
warning. Long file lists are explicitly shortened to fit the controller warning.
An abruptly terminated controller cannot finish its in-memory audit.
