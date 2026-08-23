#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RECOVERY_SEED_BYTES, recoverySeedBytes } from './lib/checkpoint.mjs';
import { loadEffectiveConfig } from './lib/config.mjs';
import { formatMode, formatModeTransition, isValidMode, PARTICIPANTS } from './lib/mode.mjs';
import { PLUGIN_ROOT, rootFromControlCwd } from './lib/paths.mjs';
import { repositoryFingerprint, updateCheckpoint } from './lib/sdk-controller.mjs';
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
  if (!updated.ok) throw updated.error ?? new Error(`state update failed safely: ${updated.health}`);
  return updated.state;
}

async function mode(root, target, participants = 'both') {
  if (!['normal', 'discussion', 'ask-once'].includes(target)) throw new ValidationError('mode must be normal, discussion, or ask-once');
  if (!PARTICIPANTS.has(participants) || !isValidMode(target, participants)) throw new ValidationError(`unsupported mode combination: ${target}/${participants}`);
  const current = await currentState(root);
  if (current.state.route === 'recovery-read-only') throw new ValidationError('mode changes are unavailable in recovery-read-only; use recover');
  const from = { route: current.state.route, participants: current.state.participants };
  const to = { route: target, participants };
  if (from.route !== to.route || from.participants !== to.participants) {
    await mutate(root, `mode-${target}-${participants}`, (state) => {
      if (target === 'ask-once' && state.route !== 'ask-once') state.returnTo = { route: state.route, participants: state.participants };
      if (target !== 'ask-once') state.returnTo = null;
      state.route = target;
      state.participants = participants;
    });
  }
  process.stdout.write(`${formatModeTransition(from, to)}\nNative permissions and sandbox: unchanged. Codex SDK sandbox is selected per queued turn.\n`);
}

async function status(root) {
  const result = await readState(root, process.env);
  const currentFingerprint = await repositoryFingerprint(result.paths.canonicalRoot);
  const checkpoint = result.state.partner.thread.checkpoint;
  const operations = result.state.operations.map(({ id, status: operationStatus, externalId, lifecycle }) => ({ id, status: operationStatus, externalId, lifecycle }));
  process.stdout.write(`${JSON.stringify({
    health: result.health,
    route: result.state.route,
    participants: result.state.participants,
    returnTo: result.state.returnTo,
    label: formatMode(result.state.route, result.state.participants),
    generation: result.state.generation,
    project: result.state.project,
    task: result.state.task,
    partner: {
      transport: result.state.partner.transport,
      status: result.state.partner.status,
      envelope: result.state.partner.envelope,
      thread: { threadId: result.state.partner.thread.threadId, metadata: result.state.partner.thread.metadata },
      checkpoint: { recoverySeedBytes: recoverySeedBytes(checkpoint, result.paths.canonicalRoot), recoverySeedLimitBytes: MAX_RECOVERY_SEED_BYTES }
    },
    controller: result.state.controller,
    currentRepoFingerprint: currentFingerprint,
    operations
  }, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const FIELD_NAMES = new Map([
  ['objective', 'objective'], ['current-task', 'currentTask'], ['constraint', 'constraints'],
  ['decision', 'acceptedDecisions'], ['relevant-file', 'relevantFiles'],
  ['implementation-status', 'implementationStatus'], ['test-status', 'testStatus'],
  ['unresolved-problem', 'unresolvedProblems'], ['next-action', 'nextAction']
]);

async function checkpoint(root, args) {
  if (args.length !== 2 || !FIELD_NAMES.has(args[0])) throw new ValidationError('checkpoint requires <field> <bounded-value>');
  const state = await updateCheckpoint(root, FIELD_NAMES.get(args[0]), args[1], process.env);
  process.stdout.write(`${JSON.stringify({ recorded: true, field: args[0], recoverySeedBytes: recoverySeedBytes(state, root), recoverySeedLimitBytes: MAX_RECOVERY_SEED_BYTES })}\n`);
}

async function config(root) {
  await initializeState(root, process.env);
  process.stdout.write(`${JSON.stringify(await loadEffectiveConfig(root, process.env), null, 2)}\n`);
}

async function recover(root, args) {
  const action = args[0];
  if (action === 'clear-dead-lock' && args.length === 1) {
    const result = await clearDeadLock(root, process.env);
    process.stdout.write(`Cleared lock owned by confirmed dead PID ${result.pid}. Recheck status before continuing.\n`);
    return;
  }
  if (action === 'resolve-transaction' && args.length === 2 && ['--commit', '--discard'].includes(args[1])) {
    const result = await resolveTransaction(root, args[1].slice(2), process.env);
    process.stdout.write(`Transaction ${result.action} completed at generation ${result.generation}. Recheck status before continuing.\n`);
    return;
  }
  if (!(args.length === 3 && args[1] === '--operation-id')) throw new ValidationError('recover action requires exactly --operation-id <uuid>');
  const id = assertUuid(args[2], 'operation id');
  const current = await currentState(root);
  const operation = current.state.operations.find((item) => item.id === id);
  if (!operation) throw new ValidationError('operation not found');
  if (action === 'inspect') {
    process.stdout.write(`${JSON.stringify({ route: current.state.route, operation: { ...operation, request: { ...operation.request, message: operation.request.message ? '[queued owner message retained]' : null } } }, null, 2)}\n`);
    return;
  }
  if (action === 'replace-missing-thread') {
    if (operation.status !== 'failed' || !/^Session not found for thread_id: [A-Za-z0-9._:-]+$/m.test(operation.result.error ?? '')) throw new ValidationError('thread replacement requires the exact SDK missing-session failure text');
    await mutate(root, 'replace-confirmed-missing-thread', (state) => {
      state.partner.thread.threadId = null;
      state.partner.status = 'not-started';
      state.route = 'normal';
      state.participants = 'both';
      state.returnTo = null;
      state.task.status = null;
    });
    process.stdout.write('Confirmed-missing SDK thread cleared. The next owner turn will create one checkpoint-seeded canonical replacement.\n');
    return;
  }
  if (action === 'abandon') {
    if (!['failed', 'cancelled'].includes(operation.status)) throw new ValidationError('only failed or cancelled operations can be abandoned');
    await mutate(root, 'partner-abandon', (state) => {
      state.operations = state.operations.filter((item) => item.id !== id);
      if (state.route === 'recovery-read-only') {
        state.route = 'normal';
        state.participants = 'both';
        state.returnTo = null;
        state.task.status = 'partner-unavailable';
      }
    });
    process.stdout.write(`Abandoned operation ${id}; external effects were not inferred or rolled back.\n`);
    return;
  }
  throw new ValidationError('recover action must be inspect, abandon, replace-missing-thread, clear-dead-lock, or resolve-transaction');
}

async function diagnose(root) {
  let metadata = {};
  try { metadata = JSON.parse(await readFile(resolve(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')); } catch {}
  const state = await readState(root, process.env);
  let hooksValid = false;
  try { JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')); hooksValid = true; } catch {}
  let sdkInstalled = false;
  try { await access(resolve(PLUGIN_ROOT, 'node_modules', '@openai', 'codex-sdk', 'package.json')); sdkInstalled = true; } catch {}
  let packageMetadata = {};
  try { packageMetadata = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'package.json'), 'utf8')); } catch {}
  let transaction = { present: false };
  try { transaction = await inspectTransaction(root, process.env); } catch (error) { transaction = { present: true, valid: false, reason: error.message }; }
  process.stdout.write(`${JSON.stringify({
    plugin: { name: metadata.name ?? 'unknown', version: metadata.version ?? 'unknown', loadedRoot: PLUGIN_ROOT, beta: true },
    node: process.version,
    platform: { value: platform(), support: platform() === 'darwin' ? 'macOS supported' : platform() === 'win32' ? 'Windows experimental' : 'not documented as supported' },
    hooks: { configPresentAndValidJson: hooksValid },
    state: { health: state.health, route: state.state.route, participants: state.state.participants, label: formatMode(state.state.route, state.state.participants), transaction },
    codex: {
      transport: 'official TypeScript SDK',
      dependency: packageMetadata.dependencies?.['@openai/codex-sdk'] ?? null,
      installed: sdkInstalled,
      authentication: 'existing Codex CLI ChatGPT subscription sign-in only; Fabex has no API-key option',
      activationVerification: 'pending plugin install/reload and live dogfood'
    }
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
  if (command === 'checkpoint') return checkpoint(root, args);
  throw new ValidationError('unknown or malformed control command');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    process.stderr.write(`fabex: ${error.message}\n`);
    if (error.details?.length) process.stderr.write(`${error.details.join('\n')}\n`);
    process.exitCode = 1;
  }
}
