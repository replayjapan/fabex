#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEffectiveConfig } from './lib/config.mjs';
import { rootFromHookInput } from './lib/paths.mjs';
import { initializeState, readState, updateState } from './lib/state.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function renderSessionContext(route, config) {
  if (route === 'normal') {
    const joint = config.collaboration.jointByDefault ? 'on' : 'off';
    return `Fabex route: normal. Joint default ${joint}; /fabex:jointly. Questions authorize answers only; never infer implementation. For ANY build, fix, change, or implement request you MUST invoke /fabex:jointly first. Codex alone edits files; never use Write/Edit, shell, or node scripts, and never ask the user for write access. Clear criteria: jointly sends directly to write-enabled Codex; verify with tests; do not duplicate analysis. Design/judgment questions: jointly gets blind independent views, then converges. Fabex = Claude & Codex together. Skip greetings/trivial lookups; /askClaude or /askCodex = one AI. Delegate image/gh/log to fabex-operational. /discussion is persistent read-only.`;
  }
  if (route === 'discussion') return 'Fabex route: discussion (persistent read-only). Analyze without project effects; /work returns to normal.';
  if (route === 'ask-once') return 'Fabex route: ask-once (one-shot read-only). Cause no project effects; the next user prompt returns to normal.';
  return 'Fabex route: recovery-read-only. Cause no project effects; use /fabex:recover.';
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
        state.route = 'normal';
        state.generation += 1;
        return state;
      }, { expectedGeneration: result.state.generation, purpose: 'ask-once-auto-revert' }, process.env);
      result = reverted.ok ? reverted : await readState(root, process.env);
    }
    const context = result.ok
      ? renderSessionContext(result.state.route, effective.config)
      : `Fabex state: ${result.health}. Route: recovery-read-only; use /fabex:recover.`;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: 'Fabex state initialization failed. Remain recovery-read-only; use /fabex:diagnose or /fabex:recover.' } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
