#!/usr/bin/env node
import { observeActivity, promptActivity, activitySnapshot, researchRoot } from './lib/activity.mjs';
import { usageLifecycle } from './lib/usage-integration.mjs';
import { authorshipPolicy } from './lib/authorship.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEffectiveConfig } from './lib/config.mjs';
import { checkpointWarnings } from './lib/checkpoint.mjs';
import { formatMode, replyBadgeInstruction } from './lib/mode.mjs';
import { rootFromHookInput } from './lib/paths.mjs';
import { initializeState, readState, updateState } from './lib/state.mjs';
import { recordOwnerPromptEvidence, notificationLikePrompt, ownerFabexCommand } from './lib/hook-evidence.mjs';
import { claudeModelSource, codexModelSource, speakerLabels } from './lib/speakers.mjs';
import { registerSession } from './lib/workspace.mjs';
import { resolveSettings, executionPlan } from './lib/workspace-settings.mjs';
import { captureOwnerDelivery, ownerDeliveries, ownerDeliveryReplay } from './lib/owner-delivery.mjs';
import { dispatchOwnerDeliveries } from './lib/sdk-controller.mjs';
import { refreshState } from './lib/conversation-refresh.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function renderSessionContext(route, participants, config, labels = speakerLabels(null, config.models?.codex?.model)) {
  const label = formatMode(route, participants);
  const badge = `${replyBadgeInstruction(label, config.display?.replyModeBadge ?? 'always')} Labels: ${labels.claude} / ${labels.codex}; never invent models. Each AI gives its own short conclusion, then Decided. Relay Codex's ownerSummary and label verbatim. Show only open issues affecting decisions, progress or results. Action required only for owner action. Omit empty sections, absent partners, block quotes and routine none flags. Stop checks the latest summary and label (legacy full-answer fallback). Full phase records remain available.`;
  if (route === 'normal' && participants === 'both') {
    const joint = config.collaboration.jointByDefault ? 'on' : 'off';
    return `Fabex mode: ${label}. ${badge} Joint default ${joint}; /fabex:jointly. Independent Phase 1 then linked Phase 2 on the canonical Codex SDK thread; verify thread.started. Never relay private reasoning. Owner grants are single-use; questions authorize answers only. Coding, Test Writing and Test Running assignments control their respective work. Reviewed Git delivery: Claude or operational agent under host permissions. Use automatically queued message IDs; legacy digest forwarding remains available. Phase 1 is read-only; reconciled owner-authorized work can build. Continue agreed work with controller continue --operation-id <completed-reconciliation-id>; never invent another owner task. Heavy jobs run sequentially: inspect heavy status and mem, wait up to 120 seconds, repeat exit 3 while feasible. Never bypass the queue or waive review/relay. Heavy recovery needs verified ownership evidence or recorded owner-named authorization. Release unused owned resources; retain requested previews. Arm open-work only for authorized work; clear finished items. New prompts disarm old work: revalidate scope. Stop only for completion, owner-action-required or a real blocker. No cumulative continuation quota.`;
  }
  if (route === 'normal' && participants === 'codex') return `Fabex participants: Codex only. ${badge} Relay Codex’s answer without adding a separate Claude assessment. Host/Modes permissions and task assignments still apply; participant selection does not grant code authorship.`;
  if (route === 'normal' && participants === 'claude') {
    return `Fabex mode: ${label}. ${badge} Questions authorize answers only. Do not consult Codex or place raw Claude-only questions/answers in its checkpoint. For implementation, use the assigned Coding AI; change participants only through owner-selected /fabex:settings participants. Claude project writes are allowlist-controlled unless a structured owner-named executor exception is active. Delegate the full Git delivery lane to fabex-operational.`;
  }
  if (route === 'discussion' && participants === 'both') return `Fabex mode: ${label}. ${badge} Persistent joint discussion. Use independent Phase 1 then linked Phase 2; never relay private reasoning or tool logs. Each phase resumes the canonical SDK thread with a read-only sandbox. Modes or the host determines the activity.`;
  if (route === 'discussion' && participants === 'claude') return `Fabex mode: ${label}. ${badge} Persistent Claude-only read-only discussion. Do not submit a Codex SDK turn or checkpoint raw Claude-only questions or answers. Use /modes:work or the host permissions to change activity.`;
  if (route === 'discussion' && participants === 'codex') return `Fabex mode: ${label}. ${badge} Persistent read-only Codex relay on the canonical SDK thread. Relay with Codex attribution and keep Claude substantively silent. Use /modes:work or the host permissions to change activity without clearing continuity.`;
  if (route === 'ask-once' && participants === 'both') return `Fabex mode: ${label}. ${badge} One-shot joint read-only answer on the canonical SDK thread. Never relay private reasoning or tool logs; always relay owner-visible replies verbatim. The next prompt restores the prior mode.`;
  if (route === 'ask-once' && participants === 'claude') return `Fabex mode: ${label}. ${badge} One-shot Claude-only read-only answer. Do not submit a Codex SDK turn or checkpoint raw Q&A. The next prompt restores the prior mode.`;
  if (route === 'ask-once' && participants === 'codex') return `Fabex mode: ${label}. ${badge} One-shot read-only Codex relay on the canonical SDK thread. The next prompt restores the prior mode.`;
  return `Fabex mode: ${label}. ${badge} Cause no project effects; use /fabex:recover.`;
}

export function captureClaudeModel(state, input) {
  const sessionId = typeof input.session_id === 'string' && input.session_id.length > 0 && input.session_id.length <= 256 ? input.session_id : null;
  const switching = input.hook_event_name === 'PostModelSwitch';
  const model = switching ? input.to_model : input.model;
  const valid = typeof model === 'string' && /^[A-Za-z0-9._:/-]{1,128}$/.test(model);
  const at = new Date().toISOString();
  if (sessionId && valid) state.claudeModel = { id: model, sessionId, at };
  else if (switching || !sessionId || state.claudeModel?.sessionId !== sessionId) state.claudeModel = null;
  if (!switching) state.sessionStartDiagnostic = sessionId ? {
    sessionId,
    source: ['startup', 'resume', 'clear', 'compact', 'fork'].includes(input.source) ? input.source : 'unknown',
    modelStatus: valid ? 'provided' : model === undefined ? 'absent' : 'invalid',
    at
  } : null;
  return state;
}

export async function main() {
  let hookEventName = 'SessionStart';
  try {
    const input = await readInput();
    hookEventName = input.hook_event_name ?? hookEventName;
    // Notifications are not chat starts or owner turns. Do not bind, rotate,
    // mirror activity or reset continuation on a helper's delivery.
    if (hookEventName === 'UserPromptSubmit' && (input.agent_id || input.agent_type || notificationLikePrompt(input.prompt))) {
      process.stdout.write('{}\n');
      return;
    }
    const root = await rootFromHookInput(input, process.env);
    const effective = await loadEffectiveConfig(root, process.env);
    if (['SessionStart', 'UserPromptSubmit'].includes(hookEventName)) {
      await observeActivity(root, input, process.env);
      if (hookEventName === 'UserPromptSubmit') await promptActivity(root, input, process.env);
    }
    let result = await initializeState(root, process.env, { recoverUnresolved: hookEventName === 'SessionStart' });
    // Automatic queue bookkeeping may briefly hold the lock between prompts.
    // Wait for that writer rather than dropping an otherwise valid next prompt.
    if (!result.ok && result.health === 'lock-contention' && hookEventName === 'UserPromptSubmit') result = await readState(root, process.env, { lockWaitMs: 3000 });
    let workspaceWarning = '';
    if (result.ok && ['SessionStart', 'UserPromptSubmit'].includes(hookEventName)) {
      try { const registered = await registerSession(root, input, process.env); workspaceWarning = (registered?.archiveWarning ?? '') + (registered?.activityMigrationNotice ? ' Activities now use /modes:work, /modes:discussion and /modes:ask. Install Modes for these commands. Fabex alone follows Claude Code permissions; plan mode is discussion. Choose partners with /fabex:settings participants and conversations with /fabex:session.' : ''); result = await readState(root, process.env); }
      catch (error) { workspaceWarning = ` Session binding not changed: ${error.message}`; }
    }
    if (result.ok && ['SessionStart', 'PostModelSwitch'].includes(hookEventName)) {
      const recorded = await updateState(root, (state) => {
        captureClaudeModel(state, { ...input, hook_event_name: hookEventName });
        state.generation += 1;
        return state;
      }, { purpose: 'session-model-metadata', lockWaitMs: 3000 }, process.env);
      result = recorded.ok ? recorded : await readState(root, process.env);
    }
    if (hookEventName === 'UserPromptSubmit' && !result.ok) {
      // Keep bounded digest evidence only; deferred state cannot establish who
      // participates. Visible failure preserves the obligation to retry capture.
      await recordOwnerPromptEvidence(root, input, process.env, { retainText: false, updateCanonicalState: false });
      throw new Error(`Owner capture requires healthy state (${result.health}); retry delivery from the existing host message after diagnosis.`);
    }
    let deliveryContext = '';
    let returnWarning = '';
    const duplicatePrompt = hookEventName === 'UserPromptSubmit' && (await ownerDeliveries(root, process.env)).some(e => ownerDeliveryReplay(e, input));
    const activity = await activitySnapshot(root, input.session_id, process.env);
    if (activity.active && result.ok && result.state.route !== 'recovery-read-only' && !result.state.modeGrant && result.state.workspace.activeSessionId === input.session_id) {
      const route = activity.activity === 'work' ? 'normal' : activity.activity === 'ask' ? 'ask-once' : 'discussion';
      const participants = resolveSettings(effective.config, result.state, input.session_id).values.participants;
      if (result.state.route !== route || result.state.participants !== participants || !result.state.ownerSelectedMode) {
        const mirrored = await updateState(root, s => {
          if (s.route === 'recovery-read-only' || s.modeGrant) return { ...s, generation: s.generation + 1 };
          s.returnTo = route === 'ask-once' ? { route: activity.returnTo === 'work' ? 'normal' : 'discussion', participants } : null;
          s.route = route; s.participants = participants;
          s.ownerSelectedMode = { route, participants, selectedAt: new Date().toISOString() };
          s.generation++; return s;
        }, { purpose: 'activity-permission-mirror' }, process.env);
        result = mirrored.ok ? mirrored : await readState(root, process.env);
      }
    }
    if (result.ok && hookEventName === 'UserPromptSubmit') {
      const captured = await captureOwnerDelivery(root, input, result.state, process.env);
      if (!captured?.duplicate) await recordOwnerPromptEvidence(root, input, process.env, { retainText: result.state.participants !== 'claude' });
      if (captured) {
        const active = result.state.operations.find(op => op.status === 'working' && op.request.phase !== 'independent' && op.result.relay?.sessionId === input.session_id);
        const deliveries = await dispatchOwnerDeliveries(root, input.session_id, process.env);
        deliveryContext = ` Owner message captured as ${captured.id}. Automatic delivery: ${JSON.stringify(deliveries)}. Do not resubmit it. ${captured.duplicate && captured.status === 'reconciled' ? 'This host event was already reconciled; do not create or seal another cycle.' : 'Seal your independent assessment for this operation before reading Codex, then reconcile.'} Incoming messages never cancel the active build. Review queued messages at the next safe point before further building. If the owner asks to stop, use the explicit controller cancel command deliberately. If delivery failed, report that failure and preserve the task.`;
        if (active && !captured.duplicate) deliveryContext += ' This message remains queued for both partners; the already-authorized active turn continues.';
      }
      result = await readState(root, process.env);
    }
    const codexModel = await codexModelSource(effective.config, process.env);
    const claudeModel = await claudeModelSource(result.state?.claudeModel?.sessionId === input.session_id ? result.state.claudeModel : null, process.env);
    let context = result.ok
      ? renderSessionContext(result.state.route, result.state.participants, effective.config, speakerLabels(claudeModel.id, codexModel.id, claudeModel.source))
      : result.health === 'migration-deferred'
        ? 'Fabex state migration is deferred while the already-loaded controller finishes its active operation. Use controller wait or non-mutating host monitoring; do not mutate state or bypass the migration gate.'
        : `Fabex state: ${result.health}. Route: recovery-read-only; use /fabex:recover.`;
    if (activity.active) context += ` Activity permission: ${activity.activity} (${activity.source}); isolated research: ${researchRoot(activity.root)}. Modes owns activity policy; Fabex owns partnership and task assignments. Restricted activity keeps the application read-only; approved research/plans use contained Modes writes or Codex's validated proposals. Report unavailable containment or remote-tool restrictions visibly.`;
    context += returnWarning;
    context += workspaceWarning;
    context += deliveryContext;
    const refresh = await refreshState(root, process.env);
    if (refresh && ['prepared', 'awaiting-receipt'].includes(refresh.status)) context += ' A checked handoff is awaiting receipt by the fresh Codex conversation. Preserve the predecessor; do not implement until receipt is verified.';
    if (result.ok && result.state.workspace?.sessions[input.session_id]) {
      const settings = resolveSettings(effective.config, result.state, input.session_id).values;
      const plan = executionPlan(effective.config, result.state, input.session_id);
      context += ` Include ownerSessionId: ${JSON.stringify(input.session_id)} in controller submission envelopes; recorded message references stay bound to this chat even when another window submits identical words.`;
      context += ` Active task assignment: ${JSON.stringify(plan)}. For a different task select control role <implementation|testWriting|testRunning|imageReview|docs|gitDelivery> before its review cycle; this chooses an existing owner-configured assignment, not new authority. The other main partner reviews. Claude-host model/effort changes are not made by Fabex: verify the chosen host model or delegate through supported host controls; do not silently substitute.`;
      context += ` ${authorshipPolicy(settings, plan).instructions}`;

      if (!settings.summaries) context += ' Optional milestone summaries are disabled; retain the minimum continuity handoff and original transcript references.';
      context += ` Milestone ${result.state.workspace.sessions[input.session_id].milestoneId}. These effective roles include conversation, milestone and project overrides; modes and host permissions still apply. Host-managed model/effort choices must be verified, never claimed from configuration alone. Before Codex Phase 1 can execute, use its automatically queued ID (submit only a legacy uncaptured message), then seal your independent assessment using controller seal --operation-id <id> with text on stdin; do not wait before sealing. Only after sealing read its answer and reconcile. Save milestone summary/handoff before switching. Returning to older work requires checking current branch and files.`;
      if (settings['usageTracker.mode'] === 'on') {
        if (['SessionStart', 'UserPromptSubmit'].includes(hookEventName)) {
          const usage = await usageLifecycle(root, 'start', '', input.session_id, process.env);
          if (usage?.startsWith('Usage unavailable:')) context += ` Report this collection failure in one plain line: ${usage}`;
        }
        context += ' Usage snapshots run at session start and delivery checkpoints/end. Stop displays the recorded usage line directly; do not repeat a reply just to include it; missing or stale readings are not live balances. Failures do not stop authorized work.';
      }
    }
    if (result.ok && result.state.partner.thread.threadId) context += ' The next Codex turn must resume this exact persisted SDK thread ID and verify the thread.started event before accepting output.';
    if (result.ok) {
      const warnings = checkpointWarnings(result.state.partner.thread.checkpoint, result.state.partner.thread.metadata, { repositoryRootConfigured: effective.config.project.repositoryRoot !== null });
      if (warnings.length) context += ` Checkpoint freshness warnings: ${warnings.length}; run Fabex status.`;
    }
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
  } catch (error) {
    const reason = `Fabex could not safely capture or deliver this owner message: ${error.message}. Keep the original host message and attachments; do not ask the owner to retype them. Report the delivery failure visibly, diagnose, and retry delivery from the retained message before affected implementation. No new implementation authority was granted.`;
    // A UserPromptSubmit block discards the host prompt. Keep it in the host
    // conversation even when private capture failed; never claim it was queued.
    process.stdout.write(`${JSON.stringify({ systemMessage: reason, hookSpecificOutput: { hookEventName, additionalContext: reason } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
