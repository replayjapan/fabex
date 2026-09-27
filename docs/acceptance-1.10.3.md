# Fabex 1.10.3 acceptance

Automated checks cover the actual question-recording hooks, explicit typed
fallback, scope persistence, cancel/back and replay rejection, grouped Testing
updates, plan milestone continuity, SDK model requests and continuation beyond
the retired counter. Run `npm test` sequentially after checking heavy status and
memory.

Live host acceptance still requires an owner-opened `/fabex:settings` dialog:

1. See Models, Who does what and Weekly usage. See the project and plan milestone.
2. Browse Claude controls, go Back, then Cancel. Verify no preference changed.
3. Select the value and its scope together in the final dialog; no additional
   confirmation is required. Check the result summary after applying. Confirm the
   hook records the answer and the next eligible request
   uses it, or reports an unavailable model clearly. Restore the broader setting.
4. For Testing, verify both writing and running preferences change together.
   Either partner can still run a check.
5. Open another chat in the same milestone. Milestone preferences survive;
   conversation preferences do not transfer. Neither creation nor title changes
   create or rename the milestone. Select a different plan stage explicitly.
6. With host questions unavailable, get the relevant scoped command from `--json`.
   Settings viewing and cancelled or expired dialogs must save nothing.

Do not manufacture owner answers for live validation or change their chosen
model/tracking preferences as part of installing this patch. Historical records
and configuration remain intact; the old new-chat milestone option is inert.

Model changes take three dialogs and task changes four. The first menu has a
visible Cancel option. The normal view shows only the project folder name, a
short typing example, and model observations only when an observed/requested
mismatch exists. Attempts to set the retired chat-milestone preference fail plainly.
