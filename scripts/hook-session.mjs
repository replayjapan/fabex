#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureOwnerMessage, markPrimaryResyncRequired, resyncPrimaryThread } from './lib/codex-adapter.mjs';
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
    return `Fabex mode: ${label}. ${badge} Joint default ${joint}; /fabex:jointly. Both means every owner message uses the primary Codex thread, including greetings and lookups. Questions authorize answers only; never infer implementation. For ANY build, fix, change, or implement request you MUST invoke /fabex:jointly first. Codex alone edits files. Current-turn opinion-blind: ask Codex before Claude's view; fetch afterward. Send owner message verbatim. Verify every resumed thread ID; mismatch stops. Repo facts may be stale. Delegate image/screenshot, GitHub/gh, and log chores to fabex-operational; this includes delivery preflight, staging, commit, and push. Approval never changes the executor; exceptions need an owner-named alternate and checkpoint records before/after.`;
  }
  if (route === 'normal' && participants === 'claude') {
    return `Fabex mode: ${label}. ${badge} Questions authorize answers only; never infer implementation. Do not automatically consult Codex. For ANY build, fix, change, or implement request you MUST invoke /fabex:jointly first; it switches to both participants. Codex alone edits files. Delegate image/screenshot, GitHub/gh, and log chores to fabex-operational; this includes delivery preflight, staging, commit, and push. Approval never changes the executor; exceptions need an owner-named alternate and checkpoint records before/after.`;
  }
  if (route === 'discussion' && participants === 'both') return `Fabex mode: ${label}. ${badge} Persistent read-only. Every owner message resumes the verified primary Codex thread with the message verbatim. Current-turn opinion-blind: invoke before publishing Claude's complete view, fetch afterward, then converge. Cause no project effects; /work exits.`;
  if (route === 'discussion' && participants === 'claude') return `Fabex mode: ${label}. ${badge} Persistent Claude-only read-only discussion. Do not invoke the Codex companion or cause project effects. /workClaude exits.`;
  if (route === 'discussion' && participants === 'codex') return `Fabex mode: ${label}. ${badge} Persistent read-only relay. Every owner message uses --resume-last on the same verified primary Codex thread with the message verbatim. Relay with Codex attribution; Claude stays substantively silent. /work exits without clearing continuity.`;
  if (route === 'ask-once' && participants === 'both') return `Fabex mode: ${label}. ${badge} One-shot read-only. Resume the verified primary Codex thread with the owner message verbatim. Current-turn opinion-blind: invoke before publishing Claude's complete view and fetch afterward; converge without project effects. The next prompt restores the prior persistent mode.`;
  if (route === 'ask-once' && participants === 'claude') return `Fabex mode: ${label}. ${badge} One-shot Claude-only read-only answer. Do not invoke the Codex companion or cause project effects. The next user prompt restores the prior persistent mode.`;
  if (route === 'ask-once' && participants === 'codex') return `Fabex mode: ${label}. ${badge} One-shot read-only relay. Resume the verified primary Codex thread with the owner message verbatim, relay with Codex attribution, and stay substantively silent. The next prompt restores the prior mode.`;
  return `Fabex mode: ${label}. ${badge} Cause no project effects; use /fabex:recover.`;
}

export async function main() {
  let hookEventName = 'SessionStart';
  let resyncNotice = null;
  try {
    const input = await readInput();
    hookEventName = input.hook_event_name ?? hookEventName;
    const root = await rootFromHookInput(input, process.env);
    const effective = await loadEffectiveConfig(root, process.env);
    let result = await initializeState(root, process.env, { recoverUnresolved: hookEventName === 'SessionStart' });
    if (result.ok && hookEventName === 'SessionStart') {
      await markPrimaryResyncRequired(root, process.env);
      result = await readState(root, process.env);
      if (result.ok && result.state.participants !== 'claude' && result.state.partner.threads.metadata.resyncStatus === 'required' && typeof input.session_id === 'string' && input.session_id.length > 0) {
        try {
          const companionEnv = { ...process.env, CODEX_COMPANION_SESSION_ID: input.session_id };
          const resynced = await resyncPrimaryThread(root, effective.config, companionEnv);
          if (resynced.performed && typeof resynced.rawOutput === 'string' && resynced.rawOutput.length > 0) resyncNotice = resynced.rawOutput;
          result = await readState(root, process.env);
        } catch {
          result = await readState(root, process.env);
        }
      }
    }
    if (result.ok && hookEventName === 'UserPromptSubmit' && typeof input.prompt === 'string') {
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
    if (resyncNotice !== null) context += ` Session re-sync Codex output follows; relay any scope or partnership-parity flag to the owner unedited: ${resyncNotice}`;
    else if (result.ok && result.state.partner.threads.metadata.resyncStatus === 'required') context += ' Primary Codex thread re-sync is required or failed; pause and ask the owner before any Codex consultation.';
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: 'Fabex state initialization failed. Remain recovery-read-only; use /fabex:diagnose or /fabex:recover.' } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
