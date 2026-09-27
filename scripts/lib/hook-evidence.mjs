import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPaths } from './paths.mjs';
import { readState, updateState } from './state.mjs';
import { changePrivate, readPrivate } from './private-store.mjs';

export const MODE_GRANT_TTL_MS = 60_000;
export const OWNER_PROMPT_RING_LIMIT = 8;
const OWNER_PROMPT_RING_BYTES = 2 * 1024 * 1024;
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
  if (typeof value !== 'string') throw new Error('hook evidence text must be a string');
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
    && typeof value.sessionId === 'string' && value.sessionId.length <= 256
    && (value.text === undefined || typeof value.text === 'string' && Buffer.byteLength(value.text) <= 192 * 1024 && textDigest(value.text) === value.digest && Buffer.byteLength(value.text) === value.bytes);
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
    const parsed = await readPrivate(file, { schemaVersion: 1, entries: [] }, OWNER_PROMPT_RING_BYTES);
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(validRingEntry).slice(-OWNER_PROMPT_RING_LIMIT);
  } catch { return []; }
}

async function appendOwnerPromptEvidence(root, evidence, env) {
  return changePrivate(root, 'owner-prompt-digests.json', { schemaVersion: 1, entries: [] }, data => {
    data.entries = [...data.entries.filter(validRingEntry).filter(entry => entry.digest !== evidence.digest || entry.sessionId !== evidence.sessionId), evidence].slice(-OWNER_PROMPT_RING_LIMIT);
    while (Buffer.byteLength(JSON.stringify(data)) > OWNER_PROMPT_RING_BYTES - 1 && data.entries.length > 1) data.entries.shift();
  }, env, OWNER_PROMPT_RING_BYTES);
}

export async function recordAuthorizedPrompt(root, text, sessionId, env = process.env, capturedAt, retainText = true) {
  const evidence = digestEvidence(text, sessionId, capturedAt);
  await appendOwnerPromptEvidence(root, { ...evidence, ...(retainText && evidence.bytes <= 192 * 1024 ? { text } : {}) }, env);
  return evidence;
}

export function normalizedPrompt(text) { return text.replace(/\r\n?/g, '\n').trimEnd(); }
export function closePrompt(a, b, limit = 5) {
  // Banded edit distance: bounded CPU even for a long owner message.
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = new Map(Array.from({ length: Math.min(b.length, limit) + 1 }, (_, i) => [i, i]));
  for (let i = 1; i <= a.length; i++) {
    const current = new Map();
    for (let j = Math.max(0, i - limit); j <= Math.min(b.length, i + limit); j++) current.set(j, j === 0 ? i : Math.min((previous.get(j) ?? Infinity) + 1, (current.get(j - 1) ?? Infinity) + 1, (previous.get(j - 1) ?? Infinity) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    if (Math.min(...current.values()) > limit) return false;
    previous = current;
  }
  return (previous.get(b.length) ?? Infinity) <= limit;
}

export async function resolveRecordedPrompt(root, envelope, state, env = process.env) {
  const all = await recentOwnerPromptEvidence(root, env);
  const sessionId = envelope.ownerSessionId ?? state.contextEvidence.ownerPrompt?.sessionId;
  const entries = all.filter(entry => typeof entry.text === 'string' && (!sessionId || entry.sessionId === sessionId));
  let candidates;
  if (envelope.ownerMessageDigest) candidates = entries.filter(entry => entry.digest === envelope.ownerMessageDigest);
  else if (envelope.ownerMessageRef === 'latest') {
    const last = Math.max(0, ...state.operations.filter(op => op.request.phase !== 'reconcile' && (!envelope.ownerSessionId || op.result.relay?.sessionId === envelope.ownerSessionId)).map(op => Date.parse(op.lifecycle.queuedAt)));
    candidates = entries.filter(entry => Date.parse(entry.capturedAt) > last);
  } else {
    if ((envelope.ownerSessionId ? entries : all).some(entry => entry.digest === textDigest(envelope.ownerMessage))) return { text: envelope.ownerMessage, substituted: false };
    if (!envelope.ownerMessage.trim()) return { text: envelope.ownerMessage, substituted: false }; // preserve image-only captions
    candidates = entries.filter(entry => normalizedPrompt(entry.text) === normalizedPrompt(envelope.ownerMessage));
    if (!candidates.length) candidates = entries.filter(entry => closePrompt(entry.text, envelope.ownerMessage));
    if (!candidates.length) return { text: envelope.ownerMessage, substituted: false };
  }
  if (candidates.length !== 1) throw new Error('recorded owner message missing or ambiguous; use its specific digest from control prompts, never reconstruct repeatedly');
  const resolution = envelope.ownerMessageDigest ? 'recorded-by-digest' : envelope.ownerMessageRef === 'latest' ? 'recorded-latest' : 'substituted-recorded-original';
  return { text: candidates[0].text, substituted: resolution === 'substituted-recorded-original', resolution, digest: candidates[0].digest };
}

async function mutate(root, purpose, change, env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readState(root, env);
    if (!current.ok) throw current.error ?? new Error(`state is ${current.health}`);
    const updated = await updateState(root, (state) => {
      change(state);
      state.generation += 1;
      return state;
    }, { expectedGeneration: current.state.generation, purpose, lockWaitMs: 3000 }, env);
    if (updated.ok) return updated.state;
    if (updated.health !== 'generation-conflict' && updated.error?.code !== 'generation-conflict') throw updated.error ?? new Error(`state update failed: ${updated.health}`);
  }
  throw new Error('state changed repeatedly while recording hook evidence');
}

export async function issueModeGrant(root, { sessionId, route, participants, ownerMessage = null, now = Date.now() }, env = process.env) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('mode authorization requires the Claude session id');
  if (ownerMessage !== null && typeof ownerMessage !== 'string') throw new Error('mode command text must be a string');
  if (ownerMessage !== null && Buffer.byteLength(ownerMessage, 'utf8') > 192 * 1024) throw new Error('mode command text exceeds 192 KiB');
  const retainedMessage = ownerMessage && ownerMessage.trim() ? ownerMessage : null;
  const grant = {
    id: randomUUID(), sessionId: sessionId.slice(0, 256), route, participants,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + MODE_GRANT_TTL_MS).toISOString(),
    ownerMessage: retainedMessage,
    operationId: retainedMessage && participants !== 'claude' ? randomUUID() : null,
    pausedAt: null,
    attachments: []
  };
  await mutate(root, 'owner-mode-grant', (state) => {
    if (state.modeGrant?.pausedAt) throw new Error('an owner mode transition is already pending');
    state.modeGrant = grant;
  }, env);
  return grant;
}

export function modeGrantMatches(grant, { id = null, sessionId = null, route, participants, now = Date.now() }) {
  return Boolean(grant && grant.id === id && grant.route === route && grant.participants === participants
    && (sessionId === null || grant.sessionId === sessionId) && (grant.pausedAt !== null || Date.parse(grant.expiresAt) >= now));
}

export async function recordOwnerPromptEvidence(root, input, env = process.env, { updateCanonicalState = true, retainText = true } = {}) {
  const prompt = input?.prompt;
  if (typeof prompt !== 'string' || notificationLikePrompt(prompt) || modeTargetForSkill(prompt.trim().split(/\s+/, 1)[0])) return null;
  const evidence = digestEvidence(prompt, input.session_id);
  await recordAuthorizedPrompt(root, prompt, input.session_id, env, evidence.capturedAt, retainText);
  if (updateCanonicalState) await mutate(root, 'hook-owner-prompt-digest', (state) => {
    state.contextEvidence.ownerPrompt = evidence;
    state.partner.thread.checkpoint.continuation = { used: 0, limit: 20, ownerDigest: evidence.digest, armed: false };
  }, env);
  return evidence;
}

export async function recordOwnerVisibleReplyEvidence(root, input, env = process.env) {
  const message = input?.last_assistant_message;
  const present = typeof message === 'string' && Boolean(message.trim());
  const evidence = present ? digestEvidence(message, input.session_id) : null;
  const available = present && Buffer.byteLength(message, 'utf8') <= 32 * 1024;
  await mutate(root, 'hook-owner-visible-reply-digest', (state) => {
    state.contextEvidence.ownerVisibleReply = evidence;
    const retain = available && state.participants !== 'claude';
    state.recordedReply = { status: retain ? 'available' : 'unavailable', text: retain ? message : null, sessionId: (input.session_id ?? '').slice(0, 256), at: new Date().toISOString() };
  }, env);
  return evidence;
}

export async function clearOwnerVisibleReplyEvidence(root, env = process.env) {
  await mutate(root, 'hook-owner-visible-reply-unavailable', (state) => { state.contextEvidence.ownerVisibleReply = null; state.recordedReply = null; }, env);
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
