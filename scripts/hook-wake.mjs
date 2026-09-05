#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForOperation } from './controller.mjs';
import { claimWakeWatcher, releaseWakeWatcher } from './lib/hook-evidence.mjs';
import { rootFromHookInput } from './lib/paths.mjs';
import { parseControllerCommand } from './hook-route-guard.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function operationIdFromHookInput(input) {
  if (parseControllerCommand(input?.tool_input?.command)?.kind !== 'controller-submit') return null;
  const pending = [input?.tool_response];
  let visited = 0;
  while (pending.length && visited < 256) {
    const value = pending.shift();
    visited += 1;
    if (typeof value === 'string') {
      const match = /["']?operationId["']?\s*:\s*["']([0-9a-f-]{36})["']/i.exec(value);
      if (match) return match[1];
      try { pending.push(JSON.parse(value)); } catch {}
    } else if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  return null;
}

export async function main() {
  let root = null;
  let claimed = false;
  try {
    const input = await readInput();
    const operationId = operationIdFromHookInput(input);
    if (!operationId) { process.stdout.write('{}\n'); return; }
    root = await rootFromHookInput(input, process.env);
    claimed = await claimWakeWatcher(root, operationId, process.pid, process.env);
    if (!claimed) { process.stdout.write('{}\n'); return; }
    const waited = await waitForOperation(root, operationId, 580, process.env);
    if (!waited.timedOut) {
      const phase = waited.operation.phase ?? 'partner';
      process.stderr.write(`Fabex ${phase} operation ${operationId} is ${waited.operation.status}. Read the bounded result or continue recovery.\n`);
      process.exitCode = 2;
    }
  } catch {}
  finally { if (claimed && root) await releaseWakeWatcher(root, process.pid, process.env).catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
