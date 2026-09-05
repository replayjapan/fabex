#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFromHookInput } from './lib/paths.mjs';
import { readState } from './lib/state.mjs';
import { clearOwnerVisibleReplyEvidence, recordOwnerVisibleReplyEvidence } from './lib/hook-evidence.mjs';
import { hasBlockingPartnerWork } from './lib/sdk-controller.mjs';

export function stopDecision(input, stateResult) {
  if (input?.stop_hook_active === true || !stateResult?.ok) return {};
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
    if (decision.decision !== 'block' && stateResult.ok) await recordOwnerVisibleReplyEvidence(root, input, process.env);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch { process.stdout.write('{}\n'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
