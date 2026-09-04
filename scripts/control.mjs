#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_ARRAY_LIMITS, CHECKPOINT_TEXT_FIELDS, checkpointWarnings, MAX_RECOVERY_SEED_BYTES, recoverySeedBytes } from './lib/checkpoint.mjs';
import { loadEffectiveConfig } from './lib/config.mjs';
import { formatMode, formatModeTransition, isValidMode, PARTICIPANTS } from './lib/mode.mjs';
import { PLUGIN_ROOT, rootFromControlCwd } from './lib/paths.mjs';
import { compactCheckpointArray, replaceCheckpointArray, repositoryFingerprint, snapshotCheckpoint, updateCheckpoint } from './lib/sdk-controller.mjs';
import { clearDeadLock, initializeState, inspectTransaction, readState, resolveTransaction, updateState } from './lib/state.mjs';
import { assertUuid, ValidationError } from './lib/validation.mjs';

const USAGE = 'Usage: control.mjs status [--all|--brief] | config | diagnose | checkpoint [--help|capacity|export|...] | mode | recover | executor-exception';
const CHECKPOINT_USAGE = 'Usage: control.mjs checkpoint capacity|export|snapshot|replace|compact|<field> <bounded-value>';

async function currentState(root) {
  const result = await readState(root, process.env);
  if (!result.ok) throw result.error ?? new Error(`state is ${result.health}; remain recovery-read-only and use recover or diagnose`);
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

async function status(root, view = 'default') {
  const result = await readState(root, process.env);
  const effective = await loadEffectiveConfig(result.paths.canonicalRoot, process.env);
  let fingerprintError = null;
  const liveFingerprintValue = await repositoryFingerprint(result.paths.canonicalRoot, effective.config).catch((error) => {
    fingerprintError = error.message;
    return { branch: null, head: null, dirty: null };
  });
  const checkpoint = result.state.partner.thread.checkpoint;
  const warnings = checkpointWarnings(checkpoint, result.state.partner.thread.metadata, { repositoryRootConfigured: effective.config.project.repositoryRoot !== null });
  if (fingerprintError) warnings.push(`repositoryRoot is invalid: ${fingerprintError}`.slice(0, 256));
  const capturedValue = result.state.partner.thread.metadata.repoFingerprint;
  if (!isDeepStrictEqual(capturedValue, liveFingerprintValue)) warnings.push('captured fingerprint differs from live');
  const terminal = result.state.operations.filter((operation) => ['completed', 'failed', 'cancelled'].includes(operation.status)).slice(-3);
  const selected = view === 'all' ? result.state.operations : result.state.operations.filter((operation) => !['completed', 'failed', 'cancelled'].includes(operation.status) || terminal.includes(operation));
  const operations = selected.map(({ id, status: operationStatus, externalId, lifecycle }) => ({ id, status: operationStatus, externalId, lifecycle }));
  const output = {
    health: result.health,
    ...(result.lock ? { lock: result.lock } : {}),
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
      checkpoint: { updatedAt: checkpoint.updatedAt, repoFingerprintCapturedAt: checkpoint.repoFingerprintCapturedAt, warnings, recoverySeedBytes: recoverySeedBytes(checkpoint, result.paths.canonicalRoot), recoverySeedLimitBytes: MAX_RECOVERY_SEED_BYTES }
    },
    capturedRepoFingerprint: { ...capturedValue, capturedAt: result.state.partner.thread.metadata.repoFingerprintCapturedAt },
    liveRepoFingerprint: { ...liveFingerprintValue, computedAt: new Date().toISOString() }
  };
  if (view !== 'brief') {
    output.controller = result.state.controller;
    output.operations = operations;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const FIELD_NAMES = new Map([
  ['objective', 'objective'], ['current-task', 'currentTask'], ['constraint', 'constraints'],
  ['decision', 'acceptedDecisions'], ['relevant-file', 'relevantFiles'],
  ['implementation-status', 'implementationStatus'], ['test-status', 'testStatus'],
  ['unresolved-problem', 'unresolvedProblems'], ['next-action', 'nextAction']
]);

async function stdinJson(limit = MAX_RECOVERY_SEED_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new ValidationError(`stdin JSON exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('stdin must contain valid JSON'); }
}

function checkpointCapacity(value, root) {
  const fields = {};
  for (const field of CHECKPOINT_TEXT_FIELDS) fields[field] = { count: value[field] === null ? 0 : 1, cap: 1, bytes: Buffer.byteLength(value[field] ?? '', 'utf8') };
  for (const [field, limit] of Object.entries(CHECKPOINT_ARRAY_LIMITS)) fields[field] = { count: value[field].length, cap: limit.count, bytes: Buffer.byteLength(JSON.stringify(value[field]), 'utf8') };
  return { fields, seed: { bytes: recoverySeedBytes(value, root), limit: MAX_RECOVERY_SEED_BYTES } };
}

async function checkpoint(root, args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    process.stdout.write(`${CHECKPOINT_USAGE}\n`);
    return;
  }
  const current = await currentState(root);
  const value = current.state.partner.thread.checkpoint;
  if (args[0] === 'capacity' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(checkpointCapacity(value, root), null, 2)}\n`);
    return;
  }
  if (args[0] === 'export' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (args[0] === 'replace' && args.length === 2 && FIELD_NAMES.has(args[1]) && CHECKPOINT_ARRAY_LIMITS[FIELD_NAMES.get(args[1])]) {
    const updated = await replaceCheckpointArray(root, FIELD_NAMES.get(args[1]), await stdinJson(), process.env);
    process.stdout.write(`${JSON.stringify({ replaced: true, field: args[1], ...checkpointCapacity(updated, root).seed })}\n`);
    return;
  }
  if (args[0] === 'compact' && args.length === 4 && FIELD_NAMES.has(args[1]) && args[2] === '--keep-last' && /^\d+$/.test(args[3])) {
    const updated = await compactCheckpointArray(root, FIELD_NAMES.get(args[1]), Number(args[3]), process.env);
    process.stdout.write(`${JSON.stringify({ compacted: true, field: args[1], ...checkpointCapacity(updated, root).seed })}\n`);
    return;
  }
  if (args[0] === 'snapshot' && args.length === 1) {
    const snapshot = await stdinJson();
    const updated = await snapshotCheckpoint(root, snapshot, process.env);
    process.stdout.write(`${JSON.stringify({ recorded: true, fields: Object.keys(snapshot), ...checkpointCapacity(updated, root).seed })}\n`);
    return;
  }
  if (args.length !== 2 || !FIELD_NAMES.has(args[0])) throw new ValidationError('checkpoint requires <field> <bounded-value>');
  const state = await updateCheckpoint(root, FIELD_NAMES.get(args[0]), args[1], process.env);
  process.stdout.write(`${JSON.stringify({ recorded: true, field: args[0], recoverySeedBytes: recoverySeedBytes(state, root), recoverySeedLimitBytes: MAX_RECOVERY_SEED_BYTES })}\n`);
}

function exactOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || args.indexOf(name, index + 1) >= 0) throw new ValidationError(`${name} is required exactly once`);
  return args[index + 1];
}

async function executorException(root, args) {
  if (args[0] === 'authorize' && args.length === 7) {
    const executor = exactOption(args, '--executor');
    const scope = exactOption(args, '--scope');
    const reason = exactOption(args, '--reason');
    if (![executor, scope, reason].every((value) => typeof value === 'string' && value.trim())) throw new ValidationError('executor exception values must be non-empty');
    await mutate(root, 'executor-exception-authorize', (state) => {
      state.executorException = { executor: executor.trim(), scope: scope.trim(), reason: reason.trim(), authorizedAt: new Date().toISOString() };
    });
    process.stdout.write('Executor exception authorized in structured state.\n');
    return;
  }
  if (args[0] === 'reconcile' && args.length === 3 && args[1] === '--outcome' && args[2].trim()) {
    await mutate(root, 'executor-exception-reconcile', (state) => { state.executorException = null; });
    process.stdout.write('Executor exception reconciled and cleared.\n');
    return;
  }
  throw new ValidationError('executor-exception requires authorize --executor <name> --scope <scope> --reason <text> or reconcile --outcome <text>');
}

async function config(root) {
  const state = await readState(root, process.env);
  const output = await loadEffectiveConfig(root, process.env);
  if (!state.ok) output.stateRead = { health: state.health, lock: state.lock };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!state.ok) process.exitCode = 2;
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
      state.partner.status = state.operations.some((item) => item.status === 'queued') ? 'queued' : 'not-started';
      state.route = 'normal';
      state.participants = 'both';
      state.returnTo = null;
      state.task.status = state.operations.some((item) => item.status === 'queued') ? 'active' : null;
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
      }
      state.task.status = state.operations.some((item) => item.status === 'queued') ? 'active' : null;
      state.partner.status = state.operations.some((item) => item.status === 'queued') ? 'queued' : state.partner.thread.threadId ? 'completed' : 'not-started';
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
  try {
    const hooks = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))?.hooks;
    hooksValid = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'].every((name) => Array.isArray(hooks?.[name]) && hooks[name].length > 0);
  } catch {}
  let sdkInstalled = false;
  try { await access(resolve(PLUGIN_ROOT, 'node_modules', '@openai', 'codex-sdk', 'package.json')); sdkInstalled = true; } catch {}
  let packageMetadata = {};
  try { packageMetadata = JSON.parse(await readFile(resolve(PLUGIN_ROOT, 'package.json'), 'utf8')); } catch {}
  let transaction = { present: false };
  try { transaction = await inspectTransaction(root, process.env); } catch (error) { transaction = { present: true, valid: false, reason: error.message }; }
  const effective = await loadEffectiveConfig(root, process.env);
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let installed = { registryVersion: null, installPath: null, matchesSource: false };
  const installWarnings = [];
  try {
    const registry = JSON.parse(await readFile(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    const direct = registry?.plugins?.['fabex@fabex'] ?? registry?.['fabex@fabex'];
    const entry = Array.isArray(direct) ? direct.at(-1) : direct;
    if (entry && typeof entry === 'object') installed = { registryVersion: entry.version ?? null, installPath: entry.installPath ?? entry.install_path ?? null, matchesSource: entry.version === metadata.version };
  } catch {}
  if (installed.registryVersion && !installed.matchesSource) installWarnings.push('installed Fabex registry metadata differs from the loaded source; update or reinstall the plugin, then restart Claude Code');
  const lastRecordedTurn = state.state.partner.thread.metadata.lastRecordedTurn;
  const activationVerified = state.ok && metadata.version && metadata.version !== 'unknown' && lastRecordedTurn?.version === metadata.version;
  const reloadRequired = installed.registryVersion && !installed.matchesSource ? true
    : installed.matchesSource && installed.installPath && resolve(installed.installPath) === PLUGIN_ROOT ? false : 'unknown';
  const activation = {
    sourceVersion: metadata.version ?? 'unknown',
    registryVersion: installed.registryVersion,
    matchesSource: installed.matchesSource,
    hooksValid,
    reloadRequired,
    lastRecordedTurn,
    verdict: !state.ok ? 'unknown' : activationVerified ? 'verified by a recorded turn on this version' : 'not verified: no turn recorded on this version'
  };
  process.stdout.write(`${JSON.stringify({
    plugin: { name: metadata.name ?? 'unknown', version: metadata.version ?? 'unknown', loadedRoot: PLUGIN_ROOT, beta: true, installed, warnings: installWarnings },
    node: process.version,
    platform: { value: platform(), support: platform() === 'darwin' ? 'macOS supported' : platform() === 'win32' ? 'Windows experimental' : 'not documented as supported' },
    hooks: { configPresentAndValidJson: hooksValid },
    state: { health: state.health, ...(state.lock ? { lock: state.lock } : {}), route: state.state.route, participants: state.state.participants, label: formatMode(state.state.route, state.state.participants), transaction },
    activation,
    codex: {
      transport: 'official TypeScript SDK',
      dependency: packageMetadata.dependencies?.['@openai/codex-sdk'] ?? null,
      installed: sdkInstalled,
      authentication: 'existing Codex CLI ChatGPT subscription sign-in only; Fabex has no API-key option'
    },
    effective: {
      networkAccessEnabled: effective.config.models.codex.networkAccessEnabled,
      repositoryRoot: effective.config.project.repositoryRoot,
      warnings: effective.warnings
    }
  }, null, 2)}\n`);
}

export async function main({ cwd = process.cwd(), argv = process.argv.slice(2) } = {}) {
  const root = await rootFromControlCwd(cwd, process.env);
  const [command, ...args] = argv;
  if ((command === undefined || command === '--help') && args.length === 0) { process.stdout.write(`${USAGE}\n`); return; }
  if (command === 'mode' && args.length === 1) return mode(root, args[0]);
  if (command === 'mode' && args.length === 3 && args[1] === '--participants') return mode(root, args[0], args[2]);
  if (command === 'status' && (args.length === 0 || args.length === 1 && ['--all', '--brief'].includes(args[0]))) return status(root, args[0] === '--all' ? 'all' : args[0] === '--brief' ? 'brief' : 'default');
  if (command === 'diagnose' && args.length === 0) return diagnose(root);
  if (command === 'config' && args.length === 0) return config(root);
  if (command === 'recover') return recover(root, args);
  if (command === 'checkpoint') return checkpoint(root, args);
  if (command === 'executor-exception') return executorException(root, args);
  throw new ValidationError('unknown or malformed control command');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    process.stderr.write(`fabex: ${error.message}\n`);
    if (error.details?.length) process.stderr.write(`${error.details.join('\n')}\n`);
    process.exitCode = 1;
  }
}
