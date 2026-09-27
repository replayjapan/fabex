# Fabex 1.10.5 acceptance

Docs Both means maintaining one shared handoff or document. Both can read it at
any time; edits happen in turn. Existing explicit single-writer preferences stay
effective. The normal independent assessments of the owner's request remain
separate from document writing.

The automated controller test starts with an existing HANDOFF.md and README.md.
Claude adds a verified decision to the handoff, Codex reads it and adds completed
work, Claude reads that update and checks the evidence, and Codex checks the
whole handoff and updates next steps. Both phases finish using the ordinary
response schema, with no documentation draft or assembly command. The test checks:

- The original topic headings and both contributions survive in the same file.
- The README is untouched and no companion document or new private draft appears.
- Old private draft data is preserved but does not gate the new workflow.
- Independent assessment sealing is still required; document sealing is not.
- Claude's edits require the bound main work session and wait for an active Codex
  operation to finish. Discussion and other sessions cannot use this author lane.
- Saved Codex main/task model choices remain distinct on their applicable turns.
- The reviewed milestone handoff references the same file after thread rotation.

The guard reuses the existing task-role author lane. It does not inspect prose
to prove that contributions are accurate or preserved, and it does not classify
allowed documents by extension. Native permissions still apply. Review verifies
the document's content, and role assignment does not authorize unrelated coding.

Live host acceptance, separate from mocked SDK tests:

1. In an authorized documentation task with Both selected, update the project's
   existing handoff using Claude's normal editor and Codex's working turn.
2. Confirm each reads the other's changes and checks the final handoff; retain
   the project's headings and attribute any unresolved disagreement where relevant.
3. Confirm no hidden draft, author-only section, or companion file is required.
4. Resume from the handoff in the next conversation and verify it identifies the
   current state, decisions, remaining work and next step.

The live two-host editing/resume check remains for Claude's acceptance review.
Tabbed navigation and account model discovery are unchanged by this patch.
