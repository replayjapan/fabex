#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEffectiveConfig } from './lib/config.mjs';
import { formatMode, replyBadgeInstruction } from './lib/mode.mjs';
import { rootFromHookInput } from './lib/paths.mjs';
import { initializeState, readState, updateState } from './lib/state.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function renderSessionContext(route, participants, config) {
  const label = formatMode(route, participants);
  const badge = replyBadgeInstruction(label, config.display?.replyModeBadge ?? 'always');
  if (route === 'normal' && participants === 'both') {
    const joint = config.collaboration.jointByDefault ? 'on' : 'off';
    return `Fabex mode: ${label}. ${badge} Joint default ${joint}; /fabex:jointly. Questions authorize answers only; never infer implementation. For ANY build, fix, change, or implement request you MUST invoke /fabex:jointly first. Codex alone edits files; never use Write/Edit, shell, or node scripts, and never ask the user for write access. Design/judgment questions use blind independent views and convergence. Skip greetings/trivial lookups. Delegate every image/screenshot inspection, GitHub/gh sequence, and log dump to fabex-operational. /discussion is persistent read-only.`;
  }
  if (route === 'normal' && participants === 'claude') {
    return `Fabex mode: ${label}. ${badge} Questions authorize answers only; never infer implementation. Do not automatically consult Codex for questions or decisions. For ANY build, fix, change, or implement request you MUST invoke /fabex:jointly first; it switches to both participants. Codex alone edits files; never use Write/Edit, shell, or node scripts, and never ask the user for write access. Delegate every image/screenshot inspection, GitHub/gh sequence, and log dump to fabex-operational. /discussionClaude is persistent read-only.`;
  }
  if (route === 'discussion' && participants === 'both') return `Fabex mode: ${label}. ${badge} Persistent read-only; cause no project effects. Before answering substantive points, invoke a fresh validated read-only Codex companion task with the user message verbatim, then give Claude's view and converge honestly. /work exits.`;
  if (route === 'discussion' && participants === 'claude') return `Fabex mode: ${label}. ${badge} Persistent Claude-only read-only discussion. Do not invoke the Codex companion or cause project effects. /workClaude exits.`;
  if (route === 'discussion' && participants === 'codex') return `Fabex mode: ${label}. ${badge} Persistent read-only relay. Use one continuous Codex thread per entry: --fresh with the user's message verbatim for the opening, then --resume-last with each follow-up verbatim. Relay answers with Codex attribution; Claude stays substantively silent. /work exits and clears the thread.`;
  if (route === 'ask-once' && participants === 'both') return `Fabex mode: ${label}. ${badge} One-shot read-only. Ask Codex in a fresh validated read-only companion task with the user message verbatim, form Claude's view, and converge without project effects. The next user prompt restores the prior persistent mode.`;
  if (route === 'ask-once' && participants === 'claude') return `Fabex mode: ${label}. ${badge} One-shot Claude-only read-only answer. Do not invoke the Codex companion or cause project effects. The next user prompt restores the prior persistent mode.`;
  if (route === 'ask-once' && participants === 'codex') return `Fabex mode: ${label}. ${badge} One-shot read-only relay. Invoke a fresh validated Codex companion task with the user message verbatim, relay its answer with Codex attribution, and stay substantively silent. The next user prompt restores the prior persistent mode.`;
  return `Fabex mode: ${label}. ${badge} Cause no project effects; use /fabex:recover.`;
}

export async function main() {
  let hookEventName = 'SessionStart';
  try {
    const input = await readInput();
    hookEventName = input.hook_event_name ?? hookEventName;
    const root = await rootFromHookInput(input);
    const effective = await loadEffectiveConfig(root, process.env);
    let result = await initializeState(root, process.env, { recoverUnresolved: hookEventName === 'SessionStart' });
    if (result.ok && hookEventName === 'UserPromptSubmit' && result.state.route === 'ask-once') {
      const reverted = await updateState(root, (state) => {
        const destination = state.returnTo ?? { route: 'normal', participants: 'both' };
        state.route = destination.route;
        state.participants = destination.participants;
        state.returnTo = null;
        state.generation += 1;
        return state;
      }, { expectedGeneration: result.state.generation, purpose: 'ask-once-auto-revert' }, process.env);
      result = reverted.ok ? reverted : await readState(root, process.env);
    }
    const context = result.ok
      ? renderSessionContext(result.state.route, result.state.participants, effective.config)
      : `Fabex state: ${result.health}. Route: recovery-read-only; use /fabex:recover.`;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: 'Fabex state initialization failed. Remain recovery-read-only; use /fabex:diagnose or /fabex:recover.' } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
