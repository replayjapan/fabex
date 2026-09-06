#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEffectiveConfig } from './lib/config.mjs';
import { checkpointWarnings } from './lib/checkpoint.mjs';
import { formatMode, replyBadgeInstruction } from './lib/mode.mjs';
import { rootFromHookInput } from './lib/paths.mjs';
import { initializeState, readState, updateState } from './lib/state.mjs';
import { recordOwnerPromptEvidence } from './lib/hook-evidence.mjs';
import { codexModelSource, speakerLabels } from './lib/speakers.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function renderSessionContext(route, participants, config, labels = speakerLabels(null, config.models?.codex?.model)) {
  const label = formatMode(route, participants);
  const badge = `${replyBadgeInstruction(label, config.display?.replyModeBadge ?? 'always')} Attribute owner-visible replies using ${labels.claude} and ${labels.codex} outside verbatim relay text; do not invent model names.`;
  if (route === 'normal' && participants === 'both') {
    const joint = config.collaboration.jointByDefault ? 'on' : 'off';
    return `Fabex mode: ${label}. ${badge} Joint default ${joint}; /fabex:jointly. Both-participant owner cycles use strict Phase 1 independent review, then a separately linked Phase 2 convergence on the same canonical Codex SDK thread. Never relay private reasoning or tool logs; relay only verbatim owner-visible context. Owner-only mode grants are single-use. Questions authorize answers only. Codex alone edits files; Claude project writes are denied unless a structured owner-named executor exception is active. Report genuine lifecycle status, verify thread.started, and delegate Git delivery to fabex-operational.`;
  }
  if (route === 'normal' && participants === 'claude') {
    return `Fabex mode: ${label}. ${badge} Questions authorize answers only. Do not consult Codex or place raw Claude-only questions/answers in its checkpoint. For implementation, ask the owner to type /fabex:work; no AI may switch participants. Claude project writes are allowlist-controlled unless a structured owner-named executor exception is active. Delegate the full Git delivery lane to fabex-operational.`;
  }
  if (route === 'discussion' && participants === 'both') return `Fabex mode: ${label}. ${badge} Persistent joint discussion. Use independent Phase 1 then linked Phase 2; never relay private reasoning or tool logs. Each phase resumes the canonical SDK thread with a read-only sandbox. Only an owner-typed mode slash command can exit.`;
  if (route === 'discussion' && participants === 'claude') return `Fabex mode: ${label}. ${badge} Persistent Claude-only read-only discussion. Do not submit a Codex SDK turn or checkpoint raw Claude-only questions or answers. Only an owner-typed /fabex:workClaude exits.`;
  if (route === 'discussion' && participants === 'codex') return `Fabex mode: ${label}. ${badge} Persistent read-only Codex relay on the canonical SDK thread. Relay with Codex attribution and keep Claude substantively silent. Only an owner-typed /fabex:work exits without clearing continuity.`;
  if (route === 'ask-once' && participants === 'both') return `Fabex mode: ${label}. ${badge} One-shot joint read-only answer on the canonical SDK thread. Never relay private reasoning or tool logs; always relay owner-visible replies verbatim. The next prompt restores the prior mode.`;
  if (route === 'ask-once' && participants === 'claude') return `Fabex mode: ${label}. ${badge} One-shot Claude-only read-only answer. Do not submit a Codex SDK turn or checkpoint raw Q&A. The next prompt restores the prior mode.`;
  if (route === 'ask-once' && participants === 'codex') return `Fabex mode: ${label}. ${badge} One-shot read-only Codex relay on the canonical SDK thread. The next prompt restores the prior mode.`;
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
      const recorded = await updateState(root, (state) => {
        state.claudeModel = typeof input.model === 'string' && /^[A-Za-z0-9._:/-]{1,128}$/.test(input.model) && typeof input.session_id === 'string' && input.session_id.length > 0 && input.session_id.length <= 256
          ? { id: input.model, sessionId: input.session_id, at: new Date().toISOString() } : null;
        state.generation += 1;
        return state;
      }, { expectedGeneration: result.state.generation, purpose: 'session-model-metadata', lockWaitMs: 3000 }, process.env);
      result = recorded.ok ? recorded : await readState(root, process.env);
    }
    if (hookEventName === 'UserPromptSubmit' && (result.ok || result.health === 'migration-deferred')) {
      await recordOwnerPromptEvidence(root, input, process.env, { updateCanonicalState: result.ok });
      if (result.ok) result = await readState(root, process.env);
    }
    if (result.ok && hookEventName === 'UserPromptSubmit' && result.state.route === 'ask-once') {
      const reverted = await updateState(root, (state) => {
        const destination = state.returnTo ?? { route: 'normal', participants: 'both' };
        state.route = destination.route;
        state.participants = destination.participants;
        state.ownerSelectedMode = { route: destination.route, participants: destination.participants, selectedAt: new Date().toISOString() };
        state.returnTo = null;
        state.generation += 1;
        return state;
      }, { expectedGeneration: result.state.generation, purpose: 'ask-once-auto-revert' }, process.env);
      result = reverted.ok ? reverted : await readState(root, process.env);
    }
    const codexModel = await codexModelSource(effective.config, process.env);
    const claudeModel = result.state?.claudeModel?.sessionId === input.session_id ? result.state.claudeModel.id : null;
    let context = result.ok
      ? renderSessionContext(result.state.route, result.state.participants, effective.config, speakerLabels(claudeModel, codexModel.id))
      : result.health === 'migration-deferred'
        ? 'Fabex state migration is deferred while the already-loaded controller finishes its active operation. Use controller wait or non-mutating host monitoring; do not mutate state or bypass the migration gate.'
        : `Fabex state: ${result.health}. Route: recovery-read-only; use /fabex:recover.`;
    if (result.ok && result.state.partner.thread.threadId) context += ' The next Codex turn must resume this exact persisted SDK thread ID and verify the thread.started event before accepting output.';
    if (result.ok) {
      const warnings = checkpointWarnings(result.state.partner.thread.checkpoint, result.state.partner.thread.metadata, { repositoryRootConfigured: effective.config.project.repositoryRoot !== null });
      if (warnings.length) context += ` Checkpoint freshness warnings: ${warnings.length}; run Fabex status.`;
    }
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: 'Fabex state initialization failed. Remain recovery-read-only; use /fabex:diagnose or /fabex:recover.' } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
