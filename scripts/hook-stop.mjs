#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFromHookInput } from './lib/paths.mjs';
import { readState, updateState } from './lib/state.mjs';
import { missingRelays, pendingRelays } from './lib/review.mjs';
import { clearOwnerVisibleReplyEvidence, recordOwnerVisibleReplyEvidence } from './lib/hook-evidence.mjs';
import { hasBlockingPartnerWork } from './lib/sdk-controller.mjs';

export function stopDecision(input, stateResult) {
  if (!stateResult?.ok) return {};
  if (missingRelays(stateResult.state, input).length) return { decision: 'block', reason: "Relay Codex's ownerSummary and label verbatim using controller relay --operation-id <uuid>. A completed Phase 2 summary replaces the new-format Phase 1 display; older records and unavailable summaries require the full answer. Full phase records remain available through result and relay --full. An owner-requested interruption may use recover abandon --operation-id <uuid> to waive that cycle's relay." };
  if (input?.stop_hook_active === true) return {};
  if (hasBlockingPartnerWork(stateResult.state)) {
    return { decision: 'block', reason: 'A Codex partner cycle is queued, working, or awaiting Phase 2. Wait for the active phase, submit its matching Phase 2, or explicitly cancel/recover before stopping.' };
  }
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
    const stateResult = await readState(root, process.env);
    const decision = stopDecision(input, stateResult);
    if (decision.decision !== 'block' && stateResult.ok) {
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
