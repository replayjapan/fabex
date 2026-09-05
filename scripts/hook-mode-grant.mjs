#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueModeGrant, modeTargetForSkill } from './lib/hook-evidence.mjs';
import { rootFromHookInput } from './lib/paths.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function modeGrantDecision(input, root, env = process.env) {
  const target = modeTargetForSkill(input?.command_name);
  if (!target) return {};
  if (input.expansion_type !== 'slash_command' || input.command_source !== 'plugin') {
    return { decision: 'block', reason: 'Fabex mode changes require an owner-typed plugin slash command.' };
  }
  const ownerMessage = typeof input.command_args === 'string' ? input.command_args : '';
  const grant = await issueModeGrant(root, { sessionId: input.session_id, ownerMessage, ...target }, env);
  const captured = grant.ownerMessage === null ? 'No trailing owner message was supplied.' : `Trailing owner message captured privately (${Buffer.byteLength(grant.ownerMessage, 'utf8')} bytes).`;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptExpansion',
      additionalContext: `Owner-issued Fabex mode grant ${grant.id}. Run the exact mode command for route=${grant.route} participants=${grant.participants} with --grant ${grant.id}; the grant expires in 60 seconds and is consumed only after a successful transition. ${captured}${grant.operationId ? ` Reserved partner operation ${grant.operationId}.` : ''}`
    }
  };
}

export async function main() {
  try {
    const input = await readInput();
    const root = await rootFromHookInput(input, process.env);
    process.stdout.write(`${JSON.stringify(await modeGrantDecision(input, root, process.env))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: 'Fabex could not verify this mode command; mode remains unchanged.' })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
