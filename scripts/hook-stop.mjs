#!/usr/bin/env node
import { blockingReviewWarning } from './lib/review-warnings.mjs';
import { dispositionProblem, continuationEligibility } from './lib/work-disposition.mjs';
import { activePartnerStop, guardStopProgress } from './lib/stop-progress.mjs';
import { usageLifecycle } from './lib/usage-integration.mjs';
import { resolve } from 'node:path';
import { stopNoticesOnce, applyStopReminder } from './lib/delivery-feedback.mjs';
import { fileURLToPath } from 'node:url';
import { rootFromHookInput } from './lib/paths.mjs';
import { readState, updateState } from './lib/state.mjs';
import { missingRelays, pendingRelays } from './lib/review.mjs';
import { clearOwnerVisibleReplyEvidence, recordOwnerVisibleReplyEvidence } from './lib/hook-evidence.mjs';
import { submissionTemplate, hasBlockingPartnerWork } from './lib/sdk-controller.mjs';
import { ownerDeliveries, deliveryObligations, syncOwnerDeliveries } from './lib/owner-delivery.mjs';

export function stopDecision(input, stateResult, deliveries = []) {
  if (!stateResult?.ok) return {};
  const state = stateResult.state;
  const obligations = deliveryObligations(deliveries, state, input.session_id);
  const missing = missingRelays(state, input);
  const notices = [];
  if (missing.length) notices.push({ key: `unread:${missing.map(op => op.id).join(',')}`,
    message: 'Some Codex answers have not been shown to you yet. They remain saved in full for the next reply; unrelated authorized work can continue.' });
  for (const item of obligations) notices.push({ key: `delivery:${item.id}:${item.status}`,
    message: item.status === 'failed' ? 'A partner message was interrupted or could not be recovered. Its unfinished work is still recorded, and unrelated authorized work can continue.'
      : 'A partner review is still unfinished. It remains recorded while unrelated authorized work continues.' });
  const latest = state.operations.findLast(op => op.status === 'completed' && op.request.phase === 'reconcile' && op.request.route === 'normal' && op.result.relay?.sessionId === input.session_id);
  const problem = latest && dispositionProblem(latest.request.workDisposition, latest.result.structured?.workDisposition, state.partner?.thread?.checkpoint);
  if (problem) notices.push({ key: `disposition:${latest.id}:${problem}`, message: 'The partners’ work records need reconciliation. Remaining work and your existing decisions are still recorded; unrelated authorized work can continue.' });
  const ownerAction = state.partner?.thread?.checkpoint?.ownerActionRequired;
  if (ownerAction) notices.push({ key: `owner-action:${ownerAction}`, message: `Fabex is waiting for your input on: ${ownerAction}` });
  const active = activePartnerStop(state);
  if (active) return { ...active, notices };
  const gaps = state.operations.filter(op => op.status === 'completed' && op.request.phase === 'independent'
    && !op.request.interrupted && (!input.session_id || op.result.relay?.sessionId === input.session_id)
    && !state.operations.some(child => child.request.parentOperationId === op.id));
  const unsealed = state.operations.filter(op => op.status === 'queued' && state.workspace?.seals?.[op.id] && !state.workspace.seals[op.id].reading
    && (!input.session_id || op.result.relay?.sessionId === input.session_id));
  const items = [
    ...missing.map(op => ({ key: `unread:${op.id}`, reason: `Include this saved Codex answer in full: controller.mjs relay --operation-id ${op.id}. This reminder will not repeat for this answer.` })),
    ...gaps.map(op => ({ key: `reconcile:${op.id}`, reason: `Review ${op.id} still needs reconciliation. Submit this shape through controller.mjs submit, replacing placeholder text with your actual assessment: ${submissionTemplate('reconcile', op.id)}. previousReplyStatus belongs only to Phase 1. If refused, correct the named field; do not repeat an unchanged submission. Saved answers and unfinished work remain recorded.` })),
    ...unsealed.map(op => ({ key: `seal:${op.id}`, reason: `Review ${op.id} is waiting for your independent assessment. Read its original request with controller.mjs status --operation-id ${op.id}, then send your assessment on stdin to controller.mjs seal --operation-id ${op.id}. Do not submit the request again. If this is a new chat, select the existing milestone to resume its saved reviews.` }))
  ];
  const reminder = items.length ? { items, key: items.map(item => item.key).join(','), reason: items.map(item => item.reason).join('\n') } : null;
  // The entry point persists the once-only receipt before turning this candidate
  // into a block. Pure decision inspection never consumes that receipt.
  const recovery = reminder ? { reminder } : {};
  const checkpoint = state.partner?.thread?.checkpoint;
  if (!problem && state.route === 'normal' && state.ownerSelectedMode?.route === 'normal' && !state.modeGrant && checkpoint?.continuation?.armed && checkpoint.openWork?.length && !checkpoint.ownerActionRequired?.trim() && !checkpoint.blocker?.trim()) {
    if (latest) {
      const eligibility = continuationEligibility(state, latest, obligations);
      if (!eligibility.ok) return { ...recovery, notices: [...notices, { key: `continuation:${latest.id}:${eligibility.reason}`, message: 'Automatic continuation is paused. The remaining work and its review records are still saved.' }] };
    }
    return { ...recovery, decision: 'block', reason: `Continue authorized feasible work: ${checkpoint.openWork.join('; ')}. ${latest ? `Run controller.mjs continue --operation-id ${latest.id}.` : 'Reconcile the current task before resuming.'} Do not ask the owner to say continue.`, notices };
  }
  return notices.length || reminder ? { ...recovery, notices } : {};
}

export async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.stdout.write('{}\n'); return; }
  let lastState;
  try {
    const root = await rootFromHookInput(input, process.env);
    if (input.hook_event_name === 'StopFailure') {
      await clearOwnerVisibleReplyEvidence(root, process.env);
      process.stdout.write('{}\n');
      return;
    }
    let stateResult = await readState(root, process.env);
    if (stateResult.ok) lastState = stateResult.state;
    if (stateResult.ok) await syncOwnerDeliveries(root, stateResult.state, process.env);
    let decision = stopDecision(input, stateResult, await ownerDeliveries(root, process.env));
    let usage = null;
    if (stateResult.ok && !hasBlockingPartnerWork(stateResult.state)) {
      const latest = stateResult.state.operations.findLast(op => op.status === 'completed' && ['reconcile', 'single'].includes(op.request.phase) && op.result.relay?.sessionId === input.session_id);
      if (latest) {
        usage = await usageLifecycle(root, 'checkpoint', latest.id, input.session_id, process.env);
        const cp = stateResult.state.partner.thread.checkpoint;
        if (latest.request.workDisposition?.status === 'done' && latest.result.structured?.workDisposition?.status === 'done' && !dispositionProblem(latest.request.workDisposition, latest.result.structured.workDisposition) && !blockingReviewWarning(latest) && !cp.openWork.length && !cp.blocker && !cp.ownerActionRequired) usage = await usageLifecycle(root, 'end', latest.id, input.session_id, process.env);
      }
    }
    // Collection can advance generation or overlap a new owner message. Recheck
    // obligations before acknowledgement instead of using a pre-collection view.
    stateResult = await readState(root, process.env);
    if (stateResult.ok) lastState = stateResult.state;
    decision = stopDecision(input, stateResult, await ownerDeliveries(root, process.env));
    const notices = decision.notices ?? [];
    delete decision.notices;
    decision = await applyStopReminder(root, input.session_id, decision, process.env);
    decision = await guardStopProgress(root, input, decision, stateResult.state ?? lastState, process.env);
    const feedback = await stopNoticesOnce(root, input.session_id, notices, process.env);
    if (feedback) decision.systemMessage = [decision.systemMessage, feedback].filter(Boolean).join('\n');
    const yielded = decision.yielded === true;
    delete decision.yielded;
    if (usage) decision.systemMessage = [decision.systemMessage, usage].filter(Boolean).join('\n');
    if (stateResult.ok) {
      // Acknowledge only answers actually present in the assistant's visible
      // reply. A reminder, saved file or emitted hook message is not delivery.
      const missing = new Set(missingRelays(stateResult.state, input).map(op => op.id));
      const shown = pendingRelays(stateResult.state, input.session_id).filter(op => !missing.has(op.id)).map(op => op.id);
      if (shown.length) {
        const marked = await updateState(root, state => {
          const stillMissing = new Set(missingRelays(state, input).map(op => op.id));
          for (const operation of state.operations) if (shown.includes(operation.id) && !stillMissing.has(operation.id) && operation.result.relay?.status === 'pending') operation.result.relay.status = 'delivered';
          state.generation += 1;
          return state;
        }, { expectedGeneration: stateResult.state.generation, purpose: 'owner-visible-relay' }, process.env);
        if (!marked.ok) decision.systemMessage = [decision.systemMessage, 'Fabex could not save confirmation that these answers reached you. They remain saved and may appear again; authorized work can continue.'].filter(Boolean).join('\n');
      }
      if (decision.decision !== 'block' && !yielded) await recordOwnerVisibleReplyEvidence(root, input, process.env);
    }
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch { process.stdout.write(`${JSON.stringify(activePartnerStop(lastState) ?? ({ systemMessage: 'Fabex could not verify delivery. Pending work and replies remain recorded; unrelated authorized work can continue.' }))}\n`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
