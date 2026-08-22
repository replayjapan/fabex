import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { loadEffectiveConfig } from './config.mjs';
import { readState, updateState } from './state.mjs';

export const MCP_CODEX_TOOL = 'mcp__codex__codex';
export const MCP_REPLY_TOOL = 'mcp__codex__codex-reply';
export const TERMINAL_OPERATION_LIMIT = 24;

const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const CONFIRMED_MISSING_CODES = new Set(['thread_not_found', 'conversation_not_found']);

export class ThreadMismatchError extends Error {
  constructor(expected, returned) {
    super(`Codex thread mismatch: recorded ${expected}, MCP returned ${returned}; recovery is required before continuing`);
    this.name = 'ThreadMismatchError';
    this.code = 'thread-mismatch';
  }
}

function boundedAppend(items, additions, { count, bytes }) {
  const accepted = additions.filter((item) => typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= bytes);
  return [...items, ...accepted].slice(-count);
}

export function pruneOperations(operations, terminalLimit = TERMINAL_OPERATION_LIMIT) {
  const unresolved = operations.filter((operation) => !TERMINAL_STATUSES.has(operation.status));
  const terminal = operations.filter((operation) => TERMINAL_STATUSES.has(operation.status)).slice(-terminalLimit);
  return [...terminal, ...unresolved];
}

async function mutate(root, purpose, fn, env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
  const updated = await updateState(root, (state) => {
    fn(state);
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose }, env);
  if (!updated.ok) throw updated.error ?? new Error(`partner state update failed safely: ${updated.health}`);
  return updated.state;
}

export async function repositoryFingerprint(root) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runFile = promisify(execFile);
  const run = async (...args) => (await runFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    const [branch, head, porcelain] = await Promise.all([
      run('branch', '--show-current'),
      run('rev-parse', 'HEAD'),
      run('status', '--porcelain=v1', '--untracked-files=normal')
    ]);
    return { branch: branch || '(detached)', head, dirty: porcelain.length > 0 };
  } catch {
    return { branch: null, head: null, dirty: null };
  }
}

export function threadTitle(projectRoot) {
  const project = basename(projectRoot) || 'project';
  return `Fabex partner — ${project} — continuous session`;
}

export function buildCheckpointSeed(checkpoint, projectRoot = 'project') {
  return [
    threadTitle(projectRoot),
    'Fabex continuity checkpoint. Treat this bounded persisted checkpoint as prior shared context.',
    `Owner goals (verbatim): ${JSON.stringify(checkpoint.ownerGoals)}`,
    `Accepted decisions: ${JSON.stringify(checkpoint.acceptedDecisions)}`,
    `Current status: ${checkpoint.currentStatus ?? 'No persisted status.'}`,
    'The repository may have changed; earlier file observations are non-authoritative. Re-read relevant files before repo-dependent conclusions.'
  ].join('\n');
}

export function verifyReturnedThread(expectedThreadId, returnedThreadId) {
  if (!THREAD_ID_RE.test(returnedThreadId ?? '')) throw new ThreadMismatchError(expectedThreadId ?? 'none', returnedThreadId ?? 'none');
  if (expectedThreadId !== null && expectedThreadId !== returnedThreadId) throw new ThreadMismatchError(expectedThreadId, returnedThreadId);
  return returnedThreadId;
}

export function planMcpCall(state, projectRoot) {
  const thread = state.partner.thread;
  if (thread.metadata.replacementStatus === 'authorized') {
    return {
      action: 'replacement',
      toolName: MCP_CODEX_TOOL,
      expectedThreadId: null,
      replacedThreadId: thread.threadId,
      seed: [
        buildCheckpointSeed(thread.checkpoint, projectRoot),
        'Visible Fabex continuity recovery: the recorded Codex MCP thread was definitively unavailable. Create the one permitted checkpoint-seeded replacement; do not infer unrecorded context.'
      ].join('\n\n')
    };
  }
  if (!thread.threadId) {
    return {
      action: 'initial',
      toolName: MCP_CODEX_TOOL,
      expectedThreadId: null,
      replacedThreadId: null,
      seed: buildCheckpointSeed(thread.checkpoint, projectRoot)
    };
  }
  return {
    action: thread.metadata.reattachStatus === 'required' ? 'reattach' : 'reply',
    toolName: MCP_REPLY_TOOL,
    expectedThreadId: thread.threadId,
    replacedThreadId: null,
    seed: thread.metadata.reattachStatus === 'required' ? buildCheckpointSeed(thread.checkpoint, projectRoot) : null
  };
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function expectedInitialArguments(root, config) {
  const expected = {
    'approval-policy': 'on-request',
    cwd: root,
    sandbox: 'workspace-write'
  };
  if (config.models.codex.model) expected.model = config.models.codex.model;
  if (config.models.codex.reasoningEffort) expected.config = { model_reasoning_effort: config.models.codex.reasoningEffort };
  return expected;
}

export function validateMcpToolArguments({ toolName, toolInput, state, root, config }) {
  const running = state.operations.filter((operation) => operation.kind === 'partner' && operation.status === 'running');
  if (running.length !== 1) return { ok: false, reason: 'exactly one recorded Codex MCP operation must be running' };
  const operation = running[0];
  const action = operation.name.split(':').at(-1);
  const expectedTool = ['initial', 'replacement'].includes(action) ? MCP_CODEX_TOOL : MCP_REPLY_TOOL;
  if (toolName !== expectedTool) return { ok: false, reason: `recorded operation requires ${expectedTool}` };
  if (typeof toolInput?.prompt !== 'string' || toolInput.prompt.length === 0 || Buffer.byteLength(toolInput.prompt, 'utf8') > 262144) {
    return { ok: false, reason: 'MCP prompt must be a non-empty string of at most 262144 UTF-8 bytes' };
  }
  if (toolName === MCP_REPLY_TOOL) {
    if (!exactKeys(toolInput, ['prompt', 'threadId'])) return { ok: false, reason: 'codex-reply accepts only prompt and threadId' };
    if (toolInput.threadId !== operation.externalId || toolInput.threadId !== state.partner.thread.threadId) {
      return { ok: false, reason: 'codex-reply threadId must exactly match the recorded canonical thread' };
    }
    return { ok: true, operation, action };
  }
  const expected = expectedInitialArguments(root, config);
  const keys = ['prompt', ...Object.keys(expected)];
  if (!exactKeys(toolInput, keys)) return { ok: false, reason: 'codex arguments contain unexpected, missing, or duplicate policy fields' };
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'config') {
      if (!exactKeys(toolInput.config, ['model_reasoning_effort']) || toolInput.config.model_reasoning_effort !== value.model_reasoning_effort) {
        return { ok: false, reason: 'codex reasoning configuration does not match Fabex configuration' };
      }
    } else if (toolInput[key] !== value) return { ok: false, reason: `codex ${key} does not match the recorded workstream policy` };
  }
  if (toolInput.prompt.split(/\r?\n/, 1)[0] !== threadTitle(root)) return { ok: false, reason: 'new Codex threads must use the stable Fabex partner title first line' };
  return { ok: true, operation, action };
}

export async function beginPartnerOperation(root, { name = 'fabex' } = {}, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner operation denied: ${current.health}`);
  if (current.state.operations.some((operation) => operation.status === 'running')) throw new Error('Codex MCP call already running for this workstream');
  if (current.state.partner.thread.metadata.replacementStatus === 'used' && !current.state.partner.thread.threadId) {
    throw new Error('the one automatic checkpoint-seeded replacement has already been used');
  }
  const plan = planMcpCall(current.state, current.paths.canonicalRoot);
  const effective = await loadEffectiveConfig(current.paths.canonicalRoot, env);
  const id = randomUUID();
  const updated = await updateState(root, (state) => {
    if (state.operations.some((operation) => operation.status === 'running')) throw new Error('Codex MCP call already running for this workstream');
    if (state.partner.thread.threadId !== current.state.partner.thread.threadId) throw new Error('canonical thread changed before MCP intent was recorded');
    state.partner.status = 'running';
    state.partner.envelope = { cwd: current.paths.canonicalRoot, sandbox: 'workspace-write', approvalPolicy: 'on-request', instructionProfile: 'continuous-canonical' };
    state.operations = pruneOperations(state.operations);
    state.operations.push({ id, kind: 'partner', name: `${name}:${plan.action}`, status: 'running', externalId: plan.expectedThreadId });
    if (plan.action === 'replacement') state.partner.thread.metadata.replacementStatus = 'used';
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'mcp-partner-intent' }, env);
  if (!updated.ok) throw updated.error ?? new Error(`partner state update failed safely: ${updated.health}`);
  const argumentsWithoutPrompt = plan.toolName === MCP_CODEX_TOOL
    ? expectedInitialArguments(current.paths.canonicalRoot, effective.config)
    : { threadId: plan.expectedThreadId };
  return { operationId: id, toolName: plan.toolName, arguments: argumentsWithoutPrompt, plan };
}

function structuredThreadId(response) {
  const structured = response?.structuredContent ?? response?.structured_content;
  return typeof structured?.threadId === 'string' ? structured.threadId : null;
}

function boundedResponseText(response) {
  const content = response?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
  return text && Buffer.byteLength(text, 'utf8') <= 8192 ? text : null;
}

function missingCode(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === 'string') return CONFIRMED_MISSING_CODES.has(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = missingCode(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['code', 'errorCode', 'error_code'].includes(key) && typeof item === 'string' && CONFIRMED_MISSING_CODES.has(item)) return item;
      const found = missingCode(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function failClosed(root, operationId, { confirmedMissing = false } = {}, env) {
  return mutate(root, confirmedMissing ? 'mcp-thread-confirmed-missing' : 'mcp-partner-interrupted', (state) => {
    const operation = state.operations.find((item) => item.id === operationId && item.status === 'running');
    if (!operation) throw new Error('partner operation is not recorded as running');
    operation.status = confirmedMissing ? 'failed' : 'interrupted';
    state.partner.status = 'pending';
    state.operations = pruneOperations(state.operations);
    if (confirmedMissing && state.partner.thread.metadata.replacementStatus !== 'used') {
      state.partner.thread.metadata.replacementStatus = 'authorized';
    } else {
      state.route = 'recovery-read-only';
      state.task.status = 'recovery-required';
    }
  }, env);
}

export async function completeMcpToolCall(root, { toolName, toolInput, toolResponse, failed = false }, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
  const effective = await loadEffectiveConfig(current.paths.canonicalRoot, env);
  const checked = validateMcpToolArguments({ toolName, toolInput, state: current.state, root: current.paths.canonicalRoot, config: effective.config });
  if (!checked.ok) {
    const running = current.state.operations.find((operation) => operation.kind === 'partner' && operation.status === 'running');
    if (running) await failClosed(root, running.id, {}, env);
    throw new Error(checked.reason);
  }
  const operation = checked.operation;
  if (failed || toolResponse?.isError === true) {
    const confirmedMissing = Boolean(missingCode(toolResponse));
    const state = await failClosed(root, operation.id, { confirmedMissing }, env);
    return { ok: false, confirmedMissing, state, operationId: operation.id };
  }
  const returnedThreadId = structuredThreadId(toolResponse);
  try {
    verifyReturnedThread(['reply', 'reattach'].includes(checked.action) ? operation.externalId : null, returnedThreadId);
  } catch (error) {
    await failClosed(root, operation.id, {}, env);
    throw error;
  }
  const observed = await repositoryFingerprint(current.paths.canonicalRoot);
  const updated = await updateState(root, (state) => {
    const target = state.operations.find((item) => item.id === operation.id && item.status === 'running');
    if (!target) throw new Error('partner operation changed concurrently');
    if (['reply', 'reattach'].includes(checked.action) && state.partner.thread.threadId !== operation.externalId) throw new Error('canonical thread changed before MCP completion');
    target.status = 'completed';
    target.externalId = returnedThreadId;
    state.partner.status = 'completed';
    state.partner.thread.threadId = returnedThreadId;
    state.partner.thread.metadata.turnCount += 1;
    state.partner.thread.metadata.lastUsedAt = new Date().toISOString();
    state.partner.thread.metadata.repoFingerprint = observed;
    state.partner.thread.metadata.reattachStatus = 'attached';
    const summary = boundedResponseText(toolResponse);
    if (summary !== null) state.partner.thread.checkpoint.currentStatus = summary;
    state.task.joint.status = 'completed';
    state.task.joint.decisionId = randomUUID();
    state.operations = pruneOperations(state.operations);
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose: 'mcp-partner-completed' }, env);
  if (!updated.ok) throw updated.error ?? new Error(`partner state update failed safely: ${updated.health}`);
  return { ok: true, verified: true, threadId: returnedThreadId, operationId: operation.id, state: updated.state };
}

export async function captureOwnerMessage(root, message, env = process.env) {
  if (typeof message !== 'string' || message.length === 0) return (await readState(root, env)).state;
  return mutate(root, 'checkpoint-owner-message', (state) => {
    state.partner.thread.checkpoint.ownerGoals = boundedAppend(state.partner.thread.checkpoint.ownerGoals, [message], { count: 8, bytes: 32768 });
  }, env);
}

export async function recordAcceptedDecision(root, decision, env = process.env) {
  if (typeof decision !== 'string' || decision.length === 0 || Buffer.byteLength(decision, 'utf8') > 2048) throw new Error('accepted decision must be a non-empty string of at most 2048 UTF-8 bytes');
  return mutate(root, 'checkpoint-accepted-decision', (state) => {
    state.partner.thread.checkpoint.acceptedDecisions = boundedAppend(state.partner.thread.checkpoint.acceptedDecisions, [decision], { count: 16, bytes: 2048 });
  }, env);
}

export async function recordCurrentStatus(root, status, env = process.env) {
  if (typeof status !== 'string' || status.length === 0 || Buffer.byteLength(status, 'utf8') > 8192) throw new Error('current status must be a non-empty string of at most 8192 UTF-8 bytes');
  return mutate(root, 'checkpoint-current-status', (state) => { state.partner.thread.checkpoint.currentStatus = status; }, env);
}

export async function markReattachRequired(root, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok || !current.state.partner.thread.threadId) return current.state;
  return mutate(root, 'session-mcp-reattach-required', (state) => {
    state.partner.thread.metadata.reattachStatus = 'required';
    state.partner.thread.metadata.replacementStatus = 'not-needed';
  }, env);
}
