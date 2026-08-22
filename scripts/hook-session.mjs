#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureOwnerMessage, markReattachRequired } from './lib/mcp-adapter.mjs';
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
    return `Fabex mode: ${label}. ${badge} Joint default ${joint}; /fabex:jointly. Both means every owner message uses one canonical Codex MCP thread across mode changes. Questions authorize answers only. For any build, fix, change, or implementation invoke /fabex:jointly first. Codex alone edits files; Claude main-session Write/Edit/NotebookEdit is denied unless an owner-named executor exception is recorded. Ask Codex before Claude's view and relay scope/parity flags unedited. Use only the exact begin-authorized MCP tool and threadId. Delegate image/screenshot, GitHub/gh, and log chores to fabex-operational with the configured model explicitly.`;
  }
  if (route === 'normal' && participants === 'claude') {
    return `Fabex mode: ${label}. ${badge} Questions authorize answers only. Do not consult Codex or place raw Claude-only questions/answers in its checkpoint. For any implementation invoke /fabex:jointly first; it switches to both. Claude main-session Write/Edit/NotebookEdit is denied unless an owner-named executor exception is recorded. Delegate image/screenshot, GitHub/gh, and log chores to fabex-operational with the configured model explicitly.`;
  }
  if (route === 'discussion' && participants === 'both') return `Fabex mode: ${label}. ${badge} Persistent behaviorally read-only discussion. Continue the canonical workspace-write Codex MCP thread with explicit no-effects instructions; MCP cannot mechanically remove its write capability. Ask Codex before Claude's view, then converge. /work exits.`;
  if (route === 'discussion' && participants === 'claude') return `Fabex mode: ${label}. ${badge} Persistent Claude-only read-only discussion. Do not invoke Codex MCP and do not checkpoint raw Claude-only questions or answers. /workClaude exits.`;
  if (route === 'discussion' && participants === 'codex') return `Fabex mode: ${label}. ${badge} Persistent behaviorally read-only Codex relay on the canonical workspace-write MCP thread. Instruct Codex to cause no effects, relay with Codex attribution, and keep Claude substantively silent. /work exits without clearing continuity.`;
  if (route === 'ask-once' && participants === 'both') return `Fabex mode: ${label}. ${badge} One-shot behaviorally read-only. Continue the canonical workspace-write Codex MCP thread with no-effects instructions, ask before Claude's view, and converge. The next prompt restores the prior mode.`;
  if (route === 'ask-once' && participants === 'claude') return `Fabex mode: ${label}. ${badge} One-shot Claude-only read-only answer. Do not invoke Codex MCP or checkpoint raw Q&A. The next prompt restores the prior mode.`;
  if (route === 'ask-once' && participants === 'codex') return `Fabex mode: ${label}. ${badge} One-shot behaviorally read-only Codex relay on the canonical workspace-write MCP thread. Instruct no effects and relay with attribution. The next prompt restores the prior mode.`;
  return `Fabex mode: ${label}. ${badge} Cause no project effects; use /fabex:recover.`;
}

export async function main() {
  let hookEventName = 'SessionStart';
  try {
    const input = await readInput();
    hookEventName = input.hook_event_name ?? hookEventName;
    const root = await rootFromHookInput(input, process.env);
    const effective = await loadEffectiveConfig(root, process.env);
    let result = await initializeState(root, process.env, { recoverUnresolved: hookEventName === 'SessionStart' });
    if (result.ok && hookEventName === 'SessionStart') {
      await markReattachRequired(root, process.env);
      result = await readState(root, process.env);
    }
    if (result.ok && hookEventName === 'UserPromptSubmit' && result.state.participants !== 'claude' && typeof input.prompt === 'string') {
      await captureOwnerMessage(root, input.prompt, process.env);
      result = await readState(root, process.env);
    }
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
    let context = result.ok
      ? renderSessionContext(result.state.route, result.state.participants, effective.config)
      : `Fabex state: ${result.health}. Route: recovery-read-only; use /fabex:recover.`;
    if (result.ok && result.state.partner.thread.metadata.reattachStatus === 'required') context += ' On the next Codex turn, make one begin-authorized exact-ID codex-reply reattachment attempt; do not create an empty re-sync turn.';
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: 'Fabex state initialization failed. Remain recovery-read-only; use /fabex:diagnose or /fabex:recover.' } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
