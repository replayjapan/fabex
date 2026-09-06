#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { issueModeGrant, modeTargetForSkill } from './lib/hook-evidence.mjs';
import { PLUGIN_ROOT, rootFromHookInput } from './lib/paths.mjs';

export async function expansionWithoutArguments(input) {
  if (!modeTargetForSkill(input?.command_name)) throw new Error('unknown Fabex mode skill');
  const skill = input.command_name.replace(/^\//, '').replace(/^fabex:/, '');
  const expanded = input.expanded_prompt ?? input.expandedPrompt ?? input.prompt;
  const args = typeof input.command_args === 'string' ? input.command_args : '';
  if (typeof expanded === 'string' && !expanded.trimStart().startsWith('/') && args) {
    const suffix = `\nARGUMENTS: ${args}`;
    if (expanded.endsWith(suffix)) return expanded.slice(0, -suffix.length);
    if (expanded.endsWith(`${suffix}\n`)) return expanded.slice(0, -suffix.length - 1);
  }
  const template = await readFile(resolve(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
  return template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
}

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
  const updatedInput = await expansionWithoutArguments(input);
  const grant = await issueModeGrant(root, { sessionId: input.session_id, ownerMessage, ...target }, env);
  const captured = grant.ownerMessage === null ? 'No trailing owner message was supplied.' : `Trailing owner message captured privately (${Buffer.byteLength(grant.ownerMessage, 'utf8')} bytes).`;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptExpansion',
      updatedInput,
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
