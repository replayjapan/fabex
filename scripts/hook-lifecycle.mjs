#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordCompaction, recordOperationalLifecycle } from './lib/hook-evidence.mjs';
import { rootFromHookInput } from './lib/paths.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function recordLifecycleInput(input, root, env = process.env) {
  if (input?.hook_event_name === 'PostCompact') return recordCompaction(root, input, env);
  if (['SubagentStart', 'SubagentStop'].includes(input?.hook_event_name)) return recordOperationalLifecycle(root, input, env);
  return null;
}

export async function main() {
  try {
    const input = await readInput();
    const root = await rootFromHookInput(input, process.env);
    await recordLifecycleInput(input, root, process.env);
  } catch {}
  process.stdout.write('{}\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
