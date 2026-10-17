#!/usr/bin/env node
import { readState } from './lib/state.mjs';
import { aliasActivity } from './lib/activity.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueModeGrant, modeTargetForSkill } from './lib/hook-evidence.mjs';
import { PLUGIN_ROOT, rootFromHookInput } from './lib/paths.mjs';
import { resolveSettings } from './lib/workspace-settings.mjs';
import { loadEffectiveConfig } from './lib/config.mjs';
import { issueWorkspaceGrant } from './lib/workspace.mjs';

export async function expansionWithoutArguments(input) {
  if (!modeTargetForSkill(input?.command_name)) throw new Error('unknown Fabex mode skill');
  const expanded = input.expanded_prompt ?? input.expandedPrompt ?? input.prompt;
  const args = typeof input.command_args === 'string' ? input.command_args : '';
  if (typeof expanded === 'string' && !expanded.trimStart().startsWith('/') && !args) return expanded;
  if (typeof expanded === 'string' && !expanded.trimStart().startsWith('/') && args) {
    const suffix = `\nARGUMENTS: ${args}`;
    if (expanded.endsWith(suffix)) return expanded.slice(0, -suffix.length);
    if (expanded.endsWith(`${suffix}\n`)) return expanded.slice(0, -suffix.length - 1);
  }
  return 'Follow the owner-selected Modes activity. Fabex handles partnership and task assignments; use the exact grant supplied by the hook.';
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function modeGrantDecision(input, root, env = process.env) {
  const settingsGrant = await issueWorkspaceGrant(root, input, env);
  if (settingsGrant?.questions) return { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: `Open the requested choice directly; show its current value and scope from these questions, without extra setup or confirmation screens. Offer AskUserQuestion with exactly ${JSON.stringify({ questions: settingsGrant.questions })}. The host PostToolUse hook must record the owner's answer before settings apply --grant ${settingsGrant.id} can run. Never choose for the owner. If the dialog is unavailable or cancelled, show the explicit scoped commands; do not apply. This grant expires in five minutes and authorizes one offered change only.` } };
  if (settingsGrant) return { hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: settingsGrant.viewing ? `View with control.mjs ${input.command_name?.replace(/^\/?fabex:/, '') === 'session' ? 'session' : 'settings'} --session ${JSON.stringify(input.session_id)}${input.command_args?.trim() === '--json' ? ' --json' : ''}; no mutation authorized.` : `Owner-issued settings grant. Run node ${PLUGIN_ROOT}/scripts/control.mjs settings apply --grant ${settingsGrant.id}. It applies only the captured owner arguments; no retyping or additional changes.` } };
  if (/^\/?fabex:(work|discussion|ask)(Claude|Codex)?$/.test(input.command_name ?? '')) return { decision: 'block', reason: 'Activities moved to /modes:work, /modes:discussion and /modes:ask. Without Modes, use Claude Code permissions (plan mode for discussion). Choose participants with /fabex:settings participants.' };
  const selected = modeTargetForSkill(input?.command_name);
  if (!selected) return {};
  const target = { ...selected };
  if (input.expansion_type !== 'slash_command' || input.command_source !== 'plugin') {
    return { decision: 'block', reason: 'Fabex mode changes require an owner-typed plugin slash command.' };
  }
  await aliasActivity(root, input, env);
  const current = await readState(root, env);
  if (!current.ok) throw new Error(current.health);
  target.participants = resolveSettings((await loadEffectiveConfig(root, env)).config, current.state, input.session_id).values.participants;
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
  let input;
  try {
    input = await readInput();
    const root = await rootFromHookInput(input, process.env);
    process.stdout.write(`${JSON.stringify(await modeGrantDecision(input, root, process.env))}\n`);
  } catch {
    const settings = typeof input?.command_name === 'string' && /^(?:\/)?(?:fabex:)?settings$/.test(input.command_name);
    const reason = settings ? 'Fabex could not open settings. No setting or mode was changed. Run /fabex:diagnose to check project state and hook health.' : 'Fabex could not verify this mode command; mode remains unchanged.';
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
