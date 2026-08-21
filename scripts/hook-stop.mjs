#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFromHookInput } from './lib/paths.mjs';
import { readState } from './lib/state.mjs';

export function stopDecision(input, stateResult) {
  if (input?.stop_hook_active === true || !stateResult?.ok) return {};
  if (stateResult.state.operations.some((operation) => operation.kind === 'partner' && operation.status === 'running')) {
    return { decision: 'block', reason: 'A Codex partner task is still running. Complete or explicitly recover it before stopping.' };
  }
  return {};
}

export async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.stdout.write('{}\n'); return; }
  if (input.stop_hook_active === true) { process.stdout.write('{}\n'); return; }
  try {
    const root = await rootFromHookInput(input, process.env);
    process.stdout.write(`${JSON.stringify(stopDecision(input, await readState(root, process.env)))}\n`);
  } catch { process.stdout.write('{}\n'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
