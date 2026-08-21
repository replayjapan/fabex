#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginPartnerOperation, completePartnerJob, completePartnerOperation, discoverCompanionRuntime, recordAcceptedDecision, repositoryFingerprint, threadRefreshAdvice } from './lib/codex-adapter.mjs';
import { loadEffectiveConfig } from './lib/config.mjs';
import { formatMode, formatModeTransition, isValidMode, PARTICIPANTS } from './lib/mode.mjs';
import { PLUGIN_ROOT, rootFromControlCwd } from './lib/paths.mjs';
import { clearDeadLock, initializeState, inspectTransaction, readState, resolveTransaction, updateState } from './lib/state.mjs';
import { assertUuid, ValidationError } from './lib/validation.mjs';

async function currentState(root) {
  const result = await readState(root, process.env);
  if (!result.ok) throw new Error(`state is ${result.health}; remain recovery-read-only and use recover or diagnose`);
  return result;
}

async function mutate(root, purpose, fn) {
  const current = await currentState(root);
  const updated = await updateState(root, (state) => {
    fn(state);
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose }, process.env);
  if (!updated.ok) throw new Error(`state update failed safely: ${updated.health}`);
  return updated.state;
}

async function mode(root, target, participants = 'both') {
  if (!['normal', 'discussion', 'ask-once'].includes(target)) throw new ValidationError('mode must be normal, discussion, or ask-once');
  if (!PARTICIPANTS.has(participants)) throw new ValidationError('participants must be both, claude, or codex');
  if (!isValidMode(target, participants)) throw new ValidationError(`unsupported mode combination: ${target}/${participants}`);
  const current = await currentState(root);
  if (current.state.route === 'recovery-read-only') throw new ValidationError('mode changes are unavailable in recovery-read-only; use recover');
  const from = { route: current.state.route, participants: current.state.participants };
  const to = { route: target, participants };
  if (from.route === to.route && from.participants === to.participants) {
    process.stdout.write(`${formatModeTransition(from, to)}\n`);
    return;
  }
  await mutate(root, `mode-${target}-${participants}`, (state) => {
    if (target === 'ask-once' && state.route !== 'ask-once') state.returnTo = { route: state.route, participants: state.participants };
    if (target !== 'ask-once') state.returnTo = null;
    state.route = target;
    state.participants = participants;
  });
  process.stdout.write(`${formatModeTransition(from, to)}\nNative permissions and sandbox: unchanged.\n`);
}

async function status(root) {
  const result = await readState(root, process.env);
  const currentFingerprint = await repositoryFingerprint(result.paths.canonicalRoot);
  const refresh = threadRefreshAdvice(result.state.partner.threads, currentFingerprint);
  const checkpoint = result.state.partner.threads.checkpoint;
  const partner = {
    transport: result.state.partner.transport,
    status: result.state.partner.status,
    envelope: result.state.partner.envelope,
    threads: {
      primaryThreadId: result.state.partner.threads.primaryThreadId,
      writeThreadId: result.state.partner.threads.writeThreadId,
      checkpoint: {
        ownerGoalCount: checkpoint.ownerGoals.length,
        acceptedDecisionCount: checkpoint.acceptedDecisions.length,
        hasCurrentStatus: checkpoint.currentStatus !== null
      },
      metadata: result.state.partner.threads.metadata
    }
  };
  process.stdout.write(`${JSON.stringify({
    health: result.health,
    route: result.state.route,
    participants: result.state.participants,
    returnTo: result.state.returnTo,
    label: formatMode(result.state.route, result.state.participants),
    generation: result.state.generation,
    project: result.state.project,
    task: result.state.task,
    partner,
    threadContinuity: {
      primaryThreadId: result.state.partner.threads.primaryThreadId,
      writeThreadId: result.state.partner.threads.writeThreadId,
      metadata: result.state.partner.threads.metadata,
      currentRepoFingerprint: currentFingerprint,
      checkpointAndRefresh: refresh
    },
    operations: result.state.operations
  }, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

async function thread(root, args) {
  const current = await currentState(root);
  if (current.state.participants === 'claude') throw new ValidationError('Claude-only mode denies Codex companion lifecycle controls; explicitly switch participants first');
  if (args[0] === 'begin' && args.length === 2 && ['primary', 'write'].includes(args[1])) {
    const kind = args[1];
    const result = await beginPartnerOperation(root, {
      threadKind: kind,
      name: 'fabex',
      envelope: {
        cwd: root,
        sandbox: kind === 'write' ? 'workspace-write' : 'read-only',
        approvalPolicy: 'native',
        instructionProfile: kind === 'write' ? 'implementation-sibling' : 'continuous-primary'
      }
    }, process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (args[0] === 'complete' && args.length === 4 && args[2] === '--thread-id') {
    const operationId = assertUuid(args[1], 'operation id');
    const threadId = args[3];
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(threadId)) throw new ValidationError('thread id is invalid');
    const operation = current.state.operations.find((item) => item.id === operationId && item.kind === 'partner' && item.status === 'running');
    const [, , action = 'resume'] = operation?.name?.split(':').slice(-3) ?? [];
    const recovered = action === 'recover';
    const replacedThreadId = recovered ? operation.externalId : null;
    const state = await completePartnerOperation(root, operationId, { threadId }, process.env);
    process.stdout.write(`${JSON.stringify({
      verified: true,
      recovered,
      recoveryReason: recovered ? 'prelaunch-resume-candidate-replacement' : null,
      replacedThreadId,
      operationId,
      threadId,
      resyncStatus: state.partner.threads.metadata.resyncStatus,
      turnCount: state.partner.threads.metadata.turnCount
    }, null, 2)}\n`);
    return;
  }
  if (args[0] === 'complete' && args.length === 4 && args[2] === '--job-id') {
    const operationId = assertUuid(args[1], 'operation id');
    const completed = await completePartnerJob(root, operationId, args[3], process.env);
    process.stdout.write(`${JSON.stringify({
      verified: completed.verified,
      recovered: completed.recovered,
      recoveryReason: completed.recoveryReason ?? null,
      replacedThreadId: completed.replacedThreadId ?? null,
      operationId,
      jobId: completed.jobId,
      threadId: completed.threadId,
      rawOutput: completed.rawOutput,
      resyncStatus: completed.state.partner.threads.metadata.resyncStatus,
      turnCount: completed.state.partner.threads.metadata.turnCount
    }, null, 2)}\n`);
    return;
  }
  if (args[0] === 'checkpoint' && args.length === 3 && args[1] === '--decision') {
    const state = await recordAcceptedDecision(root, args[2], process.env);
    process.stdout.write(`${JSON.stringify({ recorded: true, acceptedDecisionCount: state.partner.threads.checkpoint.acceptedDecisions.length })}\n`);
    return;
  }
  throw new ValidationError('thread requires begin, complete, or checkpoint --decision <accepted-decision>');
}

async function config(root) {
  await initializeState(root, process.env);
  process.stdout.write(`${JSON.stringify(await loadEffectiveConfig(root, process.env), null, 2)}\n`);
}

function unresolvedOperation(state, id) {
  return state.operations.find((operation) => operation.id === id && ['running', 'failed', 'interrupted'].includes(operation.status));
}

async function recover(root, args) {
  const action = args[0];
  if (action === 'clear-dead-lock') {
    if (args.length !== 1) throw new ValidationError('clear-dead-lock accepts no additional arguments');
    const result = await clearDeadLock(root, process.env);
    process.stdout.write(`Cleared lock owned by confirmed dead PID ${result.pid}. Recheck status before continuing.\n`);
    return;
  }
  if (action === 'resolve-transaction') {
    if (!(args.length === 2 && ['--commit', '--discard'].includes(args[1]))) throw new ValidationError('resolve-transaction requires exactly --commit or --discard');
    const result = await resolveTransaction(root, args[1].slice(2), process.env);
    process.stdout.write(`Transaction ${result.action} completed at generation ${result.generation}. Recheck status before continuing.\n`);
    return;
  }
  if (!(args.length === 3 && args[1] === '--operation-id')) throw new ValidationError('recover action requires exactly one --operation-id UUID argument');
  const id = assertUuid(args[2], 'operation id');
  const current = await currentState(root);
  const operation = unresolvedOperation(current.state, id);
  if (!operation) throw new ValidationError('recovery action is limited to a recorded unresolved partner operation id');
  if (action === 'inspect') {
    process.stdout.write(`${JSON.stringify({ route: current.state.route, operation }, null, 2)}\n`);
    return;
  }
  if (action === 'retry') {
    await mutate(root, 'partner-retry', (state) => {
      const candidate = unresolvedOperation(state, id);
      if (!candidate) throw new ValidationError('partner operation is no longer unresolved');
      candidate.status = 'running';
      state.partner.status = 'running';
    });
    process.stdout.write(`Partner retry armed for operation ${id}. Invoke only the recorded Codex partner task.\n`);
    return;
  }
  if (action === 'abandon') {
    await mutate(root, 'partner-abandon', (state) => {
      if (!unresolvedOperation(state, id)) throw new ValidationError('partner operation is no longer unresolved');
      state.operations = state.operations.filter((item) => item.id !== id);
      state.route = 'normal';
      state.participants = 'both';
      state.returnTo = null;
      state.task.status = 'partner-unavailable';
      state.task.joint.status = 'unavailable';
      state.partner.status = 'unavailable';
    });
    process.stdout.write(`Abandoned operation ${id}; Fabex will not retry it. External effects were not inferred or rolled back.\n`);
    return;
  }
  throw new ValidationError('recover action must be inspect, retry, abandon, clear-dead-lock, or resolve-transaction');
}

async function diagnose(root) {
  let metadata = {};
  try { metadata = JSON.parse(await readFile(resolve(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')); } catch {}
  const state = await readState(root, process.env);
  let hooksValid = false;
  try { JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')); hooksValid = true; } catch {}
  const companionRoot = await discoverCompanionRuntime(process.env);
  let transaction = { present: false };
  try { transaction = await inspectTransaction(root, process.env); } catch (error) { transaction = { present: true, valid: false, reason: error.message }; }
  process.stdout.write(`${JSON.stringify({
    plugin: { name: metadata.name ?? 'unknown', version: metadata.version ?? 'unknown' },
    node: process.version,
    platform: { value: platform(), support: platform() === 'darwin' ? 'macOS supported' : platform() === 'win32' ? 'Windows experimental' : 'not documented as supported' },
    hooks: { configPresentAndValidJson: hooksValid },
    state: { health: state.health, route: state.state.route, participants: state.state.participants, label: formatMode(state.state.route, state.state.participants), transaction },
    codex: { companionRuntimeAvailable: Boolean(companionRoot), location: companionRoot }
  }, null, 2)}\n`);
}

export async function main({ cwd = process.cwd(), argv = process.argv.slice(2) } = {}) {
  const root = await rootFromControlCwd(cwd, process.env);
  const [command, ...args] = argv;
  if (command === 'mode' && args.length === 1) return mode(root, args[0]);
  if (command === 'mode' && args.length === 3 && args[1] === '--participants') return mode(root, args[0], args[2]);
  if (command === 'status' && args.length === 0) return status(root);
  if (command === 'diagnose' && args.length === 0) return diagnose(root);
  if (command === 'config' && args.length === 0) return config(root);
  if (command === 'recover') return recover(root, args);
  if (command === 'thread') return thread(root, args);
  throw new ValidationError('unknown or malformed control command');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    process.stderr.write(`fabex: ${error.message}\n`);
    if (error.details?.length) process.stderr.write(`${error.details.join('\n')}\n`);
    process.exitCode = 1;
  }
}
