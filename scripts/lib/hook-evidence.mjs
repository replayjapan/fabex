import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPaths } from './paths.mjs';
import { readState, updateState } from './state.mjs';

export const MODE_GRANT_TTL_MS = 60_000;
export const OWNER_PROMPT_RING_LIMIT = 8;
const OWNER_PROMPT_RING_BYTES = 16 * 1024;
const NOTIFICATION_PROMPT_RE = /<task-notification>|\[SYSTEM NOTIFICATION|<system-reminder>|<local-command-caveat>/i;

const MODE_SKILLS = new Map([
  ['work', { route: 'normal', participants: 'both' }],
  ['workClaude', { route: 'normal', participants: 'claude' }],
  ['discussion', { route: 'discussion', participants: 'both' }],
  ['discussionClaude', { route: 'discussion', participants: 'claude' }],
  ['discussionCodex', { route: 'discussion', participants: 'codex' }],
  ['ask', { route: 'ask-once', participants: 'both' }],
  ['askClaude', { route: 'ask-once', participants: 'claude' }],
  ['askCodex', { route: 'ask-once', participants: 'codex' }]
]);

export function textDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestEvidence(value, sessionId, capturedAt = new Date().toISOString()) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('hook evidence text must be non-empty');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('hook evidence requires a session id');
  return { digest: textDigest(value), bytes: Buffer.byteLength(value, 'utf8'), capturedAt, sessionId: sessionId.slice(0, 256) };
}

export function modeTargetForSkill(value) {
  if (typeof value !== 'string') return null;
  const unscoped = value.replace(/^\//, '').replace(/^fabex:/, '');
  return MODE_SKILLS.get(unscoped) ?? null;
}

export function notificationLikePrompt(value) {
  return typeof value === 'string' && NOTIFICATION_PROMPT_RE.test(value);
}

function validRingEntry(value) {
  return value && typeof value === 'object' && /^[a-f0-9]{64}$/.test(value.digest ?? '')
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && typeof value.capturedAt === 'string' && !Number.isNaN(Date.parse(value.capturedAt))
    && typeof value.sessionId === 'string' && value.sessionId.length <= 256;
}

async function promptRingPath(root, env) {
  const paths = await projectPaths(root, env);
  return { directory: paths.projectDir, file: join(paths.projectDir, 'owner-prompt-digests.json') };
}

export async function recentOwnerPromptEvidence(root, env = process.env) {
  const { file } = await promptRingPath(root, env);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > OWNER_PROMPT_RING_BYTES) return [];
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(validRingEntry).slice(-OWNER_PROMPT_RING_LIMIT);
  } catch { return []; }
}

async function appendOwnerPromptEvidence(root, evidence, env) {
  const { directory, file } = await promptRingPath(root, env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const entries = [...await recentOwnerPromptEvidence(root, env), evidence].slice(-OWNER_PROMPT_RING_LIMIT);
  const value = `${JSON.stringify({ schemaVersion: 1, entries })}\n`;
  if (Buffer.byteLength(value, 'utf8') > OWNER_PROMPT_RING_BYTES) throw new Error('owner prompt evidence ring exceeds its private storage limit');
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function mutate(root, purpose, change, env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readState(root, env);
    if (!current.ok) throw current.error ?? new Error(`state is ${current.health}`);
    const updated = await updateState(root, (state) => {
      change(state);
      state.generation += 1;
      return state;
    }, { expectedGeneration: current.state.generation, purpose }, env);
    if (updated.ok) return updated.state;
    if (updated.health !== 'generation-conflict' && updated.error?.code !== 'generation-conflict') throw updated.error ?? new Error(`state update failed: ${updated.health}`);
  }
  throw new Error('state changed repeatedly while recording hook evidence');
}

export async function issueModeGrant(root, { sessionId, route, participants, now = Date.now() }, env = process.env) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('mode authorization requires the Claude session id');
  const grant = {
    id: randomUUID(), sessionId: sessionId.slice(0, 256), route, participants,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + MODE_GRANT_TTL_MS).toISOString()
  };
  await mutate(root, 'owner-mode-grant', (state) => { state.modeGrant = grant; }, env);
  return grant;
}

export function modeGrantMatches(grant, { id = null, sessionId = null, route, participants, now = Date.now() }) {
  return Boolean(grant && grant.id === id && grant.route === route && grant.participants === participants
    && (sessionId === null || grant.sessionId === sessionId) && Date.parse(grant.expiresAt) >= now);
}

export async function consumeModeGrant(root, { id, route, participants, now = Date.now() }, env = process.env) {
  let consumed = false;
  await mutate(root, 'owner-mode-grant-consume', (state) => {
    if (!modeGrantMatches(state.modeGrant, { id, route, participants, now })) throw new Error('mode change requires a matching unexpired owner-issued grant');
    state.modeGrant = null;
    consumed = true;
  }, env);
  return consumed;
}

export async function recordOwnerPromptEvidence(root, input, env = process.env, { updateCanonicalState = true } = {}) {
  const prompt = input?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || notificationLikePrompt(prompt) || modeTargetForSkill(prompt.trim().split(/\s+/, 1)[0])) return null;
  const evidence = digestEvidence(prompt, input.session_id);
  await appendOwnerPromptEvidence(root, evidence, env);
  if (updateCanonicalState) await mutate(root, 'hook-owner-prompt-digest', (state) => { state.contextEvidence.ownerPrompt = evidence; }, env);
  return evidence;
}

export async function recordOwnerVisibleReplyEvidence(root, input, env = process.env) {
  const message = input?.last_assistant_message;
  if (typeof message !== 'string' || !message.trim()) return null;
  const evidence = digestEvidence(message, input.session_id);
  await mutate(root, 'hook-owner-visible-reply-digest', (state) => { state.contextEvidence.ownerVisibleReply = evidence; }, env);
  return evidence;
}

export async function clearOwnerVisibleReplyEvidence(root, env = process.env) {
  await mutate(root, 'hook-owner-visible-reply-unavailable', (state) => { state.contextEvidence.ownerVisibleReply = null; }, env);
}

export async function recordCompaction(root, input, env = process.env) {
  if (!['manual', 'auto'].includes(input?.trigger) || typeof input?.session_id !== 'string') return null;
  const value = { at: new Date().toISOString(), trigger: input.trigger, sessionId: input.session_id.slice(0, 256) };
  await mutate(root, 'hook-compaction-stamp', (state) => { state.partner.thread.metadata.lastCompaction = value; }, env);
  return value;
}

export async function recordOperationalLifecycle(root, input, env = process.env) {
  if (input?.agent_type !== 'fabex:fabex-operational' || typeof input.agent_id !== 'string' || !input.agent_id.trim()) return null;
  const now = new Date().toISOString();
  if (input.hook_event_name === 'SubagentStart') {
    const value = { agentId: input.agent_id.slice(0, 256), status: 'working', startedAt: now, finishedAt: null, resultDigest: null };
    await mutate(root, 'hook-operational-start', (state) => { state.operationalDelivery = value; }, env);
    return value;
  }
  if (input.hook_event_name === 'SubagentStop') {
    const resultDigest = typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim() ? textDigest(input.last_assistant_message) : null;
    let value = null;
    await mutate(root, 'hook-operational-stop', (state) => {
      const startedAt = state.operationalDelivery?.agentId === input.agent_id ? state.operationalDelivery.startedAt : now;
      value = { agentId: input.agent_id.slice(0, 256), status: 'completed', startedAt, finishedAt: now, resultDigest };
      state.operationalDelivery = value;
    }, env);
    return value;
  }
  return null;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export async function claimWakeWatcher(root, operationId, pid = process.pid, env = process.env) {
  let claimed = false;
  await mutate(root, 'hook-wake-watcher-claim', (state) => {
    const existing = state.controller.wakeWatcher;
    if (existing && processAlive(existing.pid)) return;
    state.controller.wakeWatcher = { pid, operationId, startedAt: new Date().toISOString() };
    claimed = true;
  }, env);
  return claimed;
}

export async function releaseWakeWatcher(root, pid = process.pid, env = process.env) {
  await mutate(root, 'hook-wake-watcher-release', (state) => {
    if (state.controller.wakeWatcher?.pid === pid) state.controller.wakeWatcher = null;
  }, env);
}
