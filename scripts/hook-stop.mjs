#!/usr/bin/env node
import { usageLifecycle } from './lib/usage-integration.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFromHookInput } from './lib/paths.mjs';
import { readState, updateState } from './lib/state.mjs';
import { missingRelays, pendingRelays } from './lib/review.mjs';
import { clearOwnerVisibleReplyEvidence, recordOwnerVisibleReplyEvidence } from './lib/hook-evidence.mjs';
import { hasBlockingPartnerWork } from './lib/sdk-controller.mjs';
import { ownerDeliveries, deliveryObligations, syncOwnerDeliveries, updateOwnerDelivery } from './lib/owner-delivery.mjs';

export function stopDecision(input, stateResult, deliveries = []) {
  if (!stateResult?.ok) return {};
  const obligations = deliveryObligations(deliveries, stateResult.state, input.session_id);
  const pending = obligations.filter(item => item.status !== 'failed');
  if (pending.length) {
    const recovery = pending.map(item => {
      const target = stateResult.state.operations.findLast(op => op.request.parentOperationId === item.id)?.id ?? item.id;
      return `message ${item.id}: controller.mjs result --operation-id ${target}; if unrecoverable, control.mjs recover abandon --operation-id ${target}`;
    }).join('; ');
    return { decision: 'block', reason: `Owner messages still require partner assessment and reconciliation: ${pending.map(item => item.id).join(', ')}. Continue their existing cycles; do not submit duplicate owner tasks. If a cycle cannot be reconciled, cancel any queued/working target with controller.mjs cancel --operation-id <target-id> and wait for its outcome, then ${recovery}. Report the interrupted delivery with its message ID and any partial edits; preserve unfinished work, never claim completion.` };
  }
  const failures = obligations.filter(item => item.status === 'failed');
  if (failures.length && !failures.every(item => (input.last_assistant_message ?? '').includes(item.id) && /unavailable|failed|cancelled|interrupted/i.test(input.last_assistant_message ?? ''))) return { decision: 'block', reason: `Partner delivery failed. Report temporary unavailability or interruption with these message IDs, preserve unfinished work, and do not claim completion: ${failures.map(item => `${item.id}: ${item.error}`).join('; ')}` };
  const missing = missingRelays(stateResult.state, input);
  if (missing.length) return { decision: 'block', reason: `Relay the missing Codex summaries and labels verbatim: ${missing.map(op => `controller.mjs relay --operation-id ${op.id}`).join('; ')}. Retrieve full records with controller.mjs result --operation-id <id>. A completed Phase 2 summary replaces its new-format Phase 1 display. Preserve unfinished work; do not resubmit these cycles.` };
  // Task completion never waives an in-flight partner-cycle obligation.
  if (input?.stop_hook_active !== true && hasBlockingPartnerWork(stateResult.state)) {
    return { decision: 'block', reason: 'A Codex partner cycle is queued, working, or awaiting Phase 2. Wait for the active phase, submit its matching Phase 2, or explicitly cancel/recover before stopping.' };
  }
  const state = stateResult.state, checkpoint = state.partner?.thread?.checkpoint;
  if (!failures.length && state.route === 'normal' && state.ownerSelectedMode?.route === 'normal' && !state.modeGrant && checkpoint?.continuation?.armed && checkpoint.openWork?.length && !checkpoint.ownerActionRequired?.trim() && !checkpoint.blocker?.trim()) {
    const preview = checkpoint.openWork.slice(0, 3).map(item => item.slice(0, 160)).join('; ') + (checkpoint.openWork.length > 3 ? `; and ${checkpoint.openWork.length - 3} more checkpoint items` : '');
    return { decision: 'block', reason: `Continue authorized feasible work: ${preview}. Do not ask the owner to say continue. Update open-work as steps finish; record a genuine blocker or owner-action-required when necessary.` };
  }
  if (input?.stop_hook_active === true) return {};
  return {};
}

export async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.stdout.write('{}\n'); return; }
  try {
    const root = await rootFromHookInput(input, process.env);
    if (input.hook_event_name === 'StopFailure') {
      await clearOwnerVisibleReplyEvidence(root, process.env);
      process.stdout.write('{}\n');
      return;
    }
    let stateResult = await readState(root, process.env);
    if (stateResult.ok) await syncOwnerDeliveries(root, stateResult.state, process.env);
    let decision = stopDecision(input, stateResult, await ownerDeliveries(root, process.env));
    let usage = null;
    if (stateResult.ok && !hasBlockingPartnerWork(stateResult.state)) {
      const latest = stateResult.state.operations.findLast(op => op.status === 'completed' && ['reconcile', 'single'].includes(op.request.phase) && op.result.relay?.sessionId === input.session_id);
      if (latest) {
        usage = await usageLifecycle(root, 'checkpoint', latest.id, input.session_id, process.env);
        const cp = stateResult.state.partner.thread.checkpoint;
        if (!cp.openWork.length && !cp.blocker && !cp.ownerActionRequired) usage = await usageLifecycle(root, 'end', latest.id, input.session_id, process.env);
      }
    }
    // Collection can advance generation or overlap a new owner message. Recheck
    // obligations before acknowledgement instead of using a pre-collection view.
    stateResult = await readState(root, process.env);
    decision = stopDecision(input, stateResult, await ownerDeliveries(root, process.env));
    if (usage) decision.systemMessage = usage; // Inform the owner without requiring another assistant reply.
    if (decision.decision !== 'block' && stateResult.ok) {
      for (const failure of deliveryObligations(await ownerDeliveries(root, process.env), stateResult.state, input.session_id).filter(item => item.status === 'failed')) await updateOwnerDelivery(root, failure.id, { failureReportedAt: new Date().toISOString() }, process.env);
      const pending = pendingRelays(stateResult.state, input.session_id).map((op) => op.id);
      if (pending.length) {
        const marked = await updateState(root, (state) => {
          if (missingRelays(state, input).length) throw new Error('relay requirements changed during Stop');
          for (const operation of state.operations) if (pending.includes(operation.id) && operation.result.relay?.status === 'pending') operation.result.relay.status = 'delivered';
          state.generation += 1;
          return state;
        }, { expectedGeneration: stateResult.state.generation, purpose: 'owner-visible-relay' }, process.env);
        if (!marked.ok) { process.stdout.write(`${JSON.stringify({ decision: 'block', reason: 'Relay acknowledgement could not be saved; retry Stop.' })}\n`); return; }
      }
      await recordOwnerVisibleReplyEvidence(root, input, process.env);
    }
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ decision: 'block', reason: 'Fabex could not verify or acknowledge the complete Codex relay; retry or diagnose before stopping.' })}\n`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
