import { randomUUID, createHash } from 'node:crypto';
import { open, readFile, mkdir, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, updateState } from './state.mjs';
import { loadEffectiveConfig } from './config.mjs';
import { emptyCheckpoint } from './checkpoint.mjs';
import { projectPaths } from './paths.mjs';
import { resolveSettings, validateSettings, SETTING_DEFAULTS, ROLE_NAMES, executionPlan } from './workspace-settings.mjs';
const exec = promisify(execFile);
const digest = text => createHash('sha256').update(text).digest('hex');
const terminal = op => ['completed', 'failed', 'cancelled'].includes(op.status);
export function cycleBusy(state) {
  return state.operations.some(op => !terminal(op) || op.status === 'completed' && op.request.phase === 'independent' && op.request.participants === 'both' && !op.request.interrupted && !state.operations.some(child => child.request.parentOperationId === op.id));
}
async function mutate(root, purpose, fn, env) {
  const result = await updateState(root, async state => { await fn(state); state.generation++; return state; }, { purpose }, env);
  if (!result.ok) throw result.error?.cause ?? result.error ?? new Error(result.health);
  return result.state;
}
export async function tailText(file, bytes = 256 * 1024) {
  const handle = await open(file, 'r');
  try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('not a file'); const start = Math.max(0, stat.size - bytes); const b = Buffer.alloc(Math.min(bytes, stat.size)); await handle.read(b, 0, b.length, start); return { text: b.toString('utf8'), partial: start > 0 }; }
  finally { await handle.close(); }
}
export function titleFromText(text, sessionId) {
  let title = null;
  for (const line of text.split('\n')) { try { const v = JSON.parse(line); if (v.type === 'custom-title' && v.sessionId === sessionId && typeof v.customTitle === 'string' && v.customTitle.trim()) title = v.customTitle.trim().slice(0, 200); } catch {} }
  return title;
}
function bind(state, id, sessionId, claimed = false) {
  const w = state.workspace;
  if (!claimed && w.activeSessionId && sessionId !== w.activeSessionId && cycleBusy(state)) throw new Error('Another chat has an active review cycle; its session settings remain bound until it finishes.');
  if (id !== w.activeMilestoneId) {
    if (!claimed && cycleBusy(state)) throw new Error('Milestone switch waits for the current independent/reconciliation cycle; no history changed.');
    w.milestones[w.activeMilestoneId].thread = structuredClone(state.partner.thread);
    const next = w.milestones[id];
    const thread = next.thread ?? { ...structuredClone(state.partner.thread), threadId: null, checkpoint: emptyCheckpoint(), metadata: { ...structuredClone(state.partner.thread.metadata), turnCount: 0, lastUsedAt: null, lastRecordedTurn: null, lastCompaction: null } };
    if (!next.thread) {
      thread.checkpoint.currentTask = next.name;
      thread.checkpoint.nextAction = next.handoff || w.milestones[w.activeMilestoneId].handoff || null;
      thread.checkpoint.constraints = structuredClone(state.partner.thread.checkpoint.constraints);
    }
    state.partner.thread = thread; w.activeMilestoneId = id;
    state.partner.thread.checkpoint.continuation.armed = false;
  }
  w.activeSessionId = sessionId;
}
export function bindQueuedSession(state, operation) {
  const sessionId = operation.result.relay?.sessionId, session = state.workspace.sessions[sessionId];
  if (!session) return; // Unregistered pre-upgrade operations keep their canonical thread.
  if (state.controller.activeOperationId) throw new Error('Cannot rebind a working operation.');
  bind(state, session.milestoneId, sessionId, true);
}
async function saveChatReferences(root, state, env) {
  const paths = await projectPaths(root, env), w = state.workspace;
  const m = w.milestones[w.activeMilestoneId];
  const slug = m.name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'milestone';
  const base = await realpath(paths.projectDir);
  const folder = join(base, 'chats', `${slug}--${m.id}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (await realpath(folder) !== folder) throw new Error('private chat archive must not be a symlink');
  const references = Object.entries(w.sessions).filter(([,s]) => s.milestoneId === m.id).map(([id,s]) => ({ sessionId: id, title: s.title, transcriptPath: s.transcriptPath }));
  const data = JSON.stringify({ milestoneId: m.id, name: m.name, references, summary: m.summary, handoff: m.handoff, threadId: state.partner.thread.threadId, archivedParts: m.parts.map(p => ({ threadId: p.threadId, archivedAt: p.archivedAt })) }, null, 2) + '\n';
  const file = join(folder, 'references.json');
  try { if (await readFile(file, 'utf8') === data) return folder; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${randomUUID()}`; await writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await rename(temp, file);
  return folder;
}
export async function registerSession(root, input, env = process.env) {
  const sessionId = input.session_id;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(sessionId)) return null;
  const config = (await loadEffectiveConfig(root, env)).config;
  let title = null;
  if (input.transcript_path) try { title = titleFromText((await tailText(input.transcript_path)).text, sessionId); } catch {}
  const state = await mutate(root, 'workspace-session-binding', state => {
    const w = state.workspace;
    let session = w.sessions[sessionId];
    if (!session) {
      const values = resolveSettings(config, state, sessionId).values;
      let id = w.activeMilestoneId;
      if (values['milestones.newChatMeansNewMilestone']) {
        id = randomUUID(); w.milestones[id] = { id, name: title ?? `Temporary ${sessionId.slice(0, 8)}`, thread: null, summary: '', handoff: '', createdAt: new Date().toISOString(), parts: [] };
      }
      session = w.sessions[sessionId] = { milestoneId: id, title: title ?? sessionId, transcriptPath: input.transcript_path ?? null, settings: {} };
    }
    if (title) {
      const milestone = w.milestones[session.milestoneId];
      if (milestone.name === session.title || milestone.name === `Temporary ${sessionId.slice(0, 8)}`) milestone.name = title;
      session.title = title;
    }
    if (input.transcript_path) session.transcriptPath = input.transcript_path;
    if (!(cycleBusy(state) && w.activeSessionId !== sessionId)) bind(state, session.milestoneId, sessionId);
  }, env);
  try { await saveChatReferences(root, state, env); } catch (error) { state.archiveWarning = `Chat references not exported: ${error.message}`; }
  if (state.workspace.activeSessionId !== sessionId) state.archiveWarning = `${state.archiveWarning ?? ''} This chat is registered; its thread and execution settings bind when its queued cycle starts.`;
  return state;
}
export async function issueWorkspaceGrant(root, input, env = process.env) {
  const command = input.command_name?.replace(/^\//, '').replace(/^fabex:/, '');
  if (!['settings', 'milestone'].includes(command)) return null;
  const args = (input.command_args ?? '').trim();
  if (!args) return { viewing: true };
  if (input.expansion_type !== 'slash_command' || input.command_source !== 'plugin' || !input.session_id) throw new Error('Settings changes require an owner-typed slash command.');
  const grant = { id: randomUUID(), command, args, sessionId: input.session_id, expiresAt: Date.now() + 300000 };
  await mutate(root, 'workspace-owner-grant', state => {
    for (const [id, value] of Object.entries(state.workspace.grants)) if (value.expiresAt < Date.now()) delete state.workspace.grants[id];
    state.workspace.grants[grant.id] = grant;
  }, env);
  return grant;
}
export function parseSettingsArgs(text) {
  const result = { scope: 'session', updates: {}, resets: [] };
  const tokens = []; let token = '', quote = null, escaped = false;
  for (const char of text) {
    if (escaped) { token += char; escaped = false; continue; }
    if (quote && char === '\\') { token += char; escaped = true; continue; }
    if (quote) { token += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; token += char; continue; }
    if (/\s/.test(char)) { if (token) tokens.push(token); token = ''; } else token += char;
  }
  if (quote || escaped) throw new Error('unterminated quoted settings value');
  if (token) tokens.push(token);
  for (const token of tokens) {
    const index = token.indexOf('='); if (index < 1) throw new Error('Use key=value scope=session|project; value=inherit removes an override.');
    const key = token.slice(0, index), raw = token.slice(index + 1);
    if (key === 'scope') { if (!['session', 'project'].includes(raw)) throw new Error('scope must be session or project'); result.scope = raw; continue; }
    if (!Object.hasOwn(SETTING_DEFAULTS, key)) throw new Error(`unknown setting ${key}`);
    let value; try { value = JSON.parse(raw); } catch { value = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw; }
    if (raw === 'inherit') result.resets.push(key); else { validateSettings({ [key]: value }); result.updates[key] = value; }
  }
  return result;
}
export async function applyWorkspaceGrant(root, grantId, env = process.env) {
  const config = (await loadEffectiveConfig(root, env)).config;
  const before = await readState(root, env); if (!before.ok) throw new Error(before.health);
  const grant = before.state.workspace.grants[grantId];
  if (!grant || grant.expiresAt < Date.now()) throw new Error('owner settings grant missing or expired');
  if (cycleBusy(before.state)) throw new Error('Apply settings between completed review cycles.');
  const parsed = grant.command === 'settings' ? parseSettingsArgs(grant.args) : null;
  const state = await mutate(root, 'workspace-apply-owner-grant', async state => {
    const w = state.workspace, current = w.grants[grantId];
    if (!current || current.expiresAt < Date.now() || cycleBusy(state)) throw new Error('settings grant expired or cycle started; retry safely');
    const session = w.sessions[grant.sessionId]; if (!session) throw new Error('session not registered; submit a normal owner message first');
    // Serialize grant verification and the idempotent config replacement. If a
    // crash follows replacement, retrying the still-present grant sets the same values.
    if (parsed?.scope === 'project') {
    const file = join(root, '.fabex', 'config.json'); let value = { schemaVersion: 1 };
    try { if ((await lstat(file)).isSymbolicLink()) throw new Error('project config writes do not follow symlinks'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    value.settings = { ...value.settings, ...parsed.updates }; for (const key of parsed.resets) delete value.settings[key];
    await mkdir(dirname(file), { recursive: true });
    const parent = await realpath(dirname(file)); if (parent !== resolve(root, '.fabex')) throw new Error('project config directory must not redirect outside the project');
    const temp = file + '.' + randomUUID(); await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, file);
    }
    if (parsed) {
      if (parsed.scope === 'session') { Object.assign(session.settings, parsed.updates); for (const key of parsed.resets) delete session.settings[key]; }
    } else {
      const name = grant.args.trim(); if (!name || name.length > 200) throw new Error('milestone name must be 1..200 characters');
      if (/^restore-part=\d+$/.test(name)) {
        bind(state, session.milestoneId, grant.sessionId);
        const milestone = w.milestones[session.milestoneId], archived = milestone.parts[Number(name.split('=')[1])];
        if (!archived) throw new Error('Unknown archived part; view milestone settings for indexes.');
        const { threadId, checkpoint, metadata } = structuredClone(archived);
        if (state.partner.thread.threadId && state.partner.thread.threadId !== threadId) milestone.parts.push({ ...structuredClone(state.partner.thread), archivedAt: new Date().toISOString() });
        state.partner.thread = { threadId, checkpoint, metadata };
        state.partner.thread.checkpoint.continuation.armed = false;
        delete w.grants[grantId]; return;
      }
      const matches = Object.values(w.milestones).filter(m => m.id === name || m.name === name);
      if (matches.length > 1) throw new Error('ambiguous milestone name; use its id');
      const id = matches[0]?.id ?? randomUUID();
      if (!matches.length) w.milestones[id] = { id, name, thread: null, summary: '', handoff: '', createdAt: new Date().toISOString(), parts: [] };
      if (session.milestoneId !== id) {
        session.profiles ??= {};
        session.profiles[session.milestoneId] = { settings: structuredClone(session.settings), activeRole: session.activeRole ?? 'implementation' };
        session.settings = structuredClone(session.profiles[id]?.settings ?? {});
        session.activeRole = session.profiles[id]?.activeRole ?? 'implementation';
      }
      bind(state, id, grant.sessionId); session.milestoneId = id;
    }
    delete w.grants[grantId];
  }, env);
  return { applied: true, ...resolveSettings((await loadEffectiveConfig(root, env)).config, state, grant.sessionId), milestone: state.workspace.activeMilestoneId, note: 'No model or Git branch is silently changed. Verify the requested host model and code state before implementation.' };
}
export async function sealReading(root, operationId, reading, env = process.env) {
  if (typeof reading !== 'string' || !reading.trim() || Buffer.byteLength(reading) > 16000) throw new Error('sealed assessment must be 1..16000 bytes');
  await mutate(root, 'seal-independent-assessment', state => {
    const op = state.operations.find(o => o.id === operationId), seal = state.workspace.seals[operationId];
    if (op && seal?.digest === digest(reading)) return;
    if (!op || !seal || op.status !== 'queued') throw new Error('seal requires its queued Phase 1, before execution');
    if (seal.reading && seal.digest !== digest(reading)) throw new Error('independent assessment already sealed');
    Object.assign(seal, { reading, digest: digest(reading), at: new Date().toISOString() });
  }, env);
  return { sealed: true, operationId, digest: digest(reading) };
}
export function assertSealed(state, operation) {
  const seal = state.workspace?.seals[operation.id]; if (seal && !seal.reading) throw new Error('Claude must seal its independent assessment before Codex Phase 1 runs or is released.');
}
export async function workspaceStatus(root, env = process.env, sessionId) {
  const current = await readState(root, env); if (!current.ok) throw new Error(current.health);
  const config = (await loadEffectiveConfig(root, env)).config;
  return { ...resolveSettings(config, current.state, sessionId), execution: executionPlan(config, current.state, sessionId), observations: current.state.workspace.observations ?? {}, activeMilestoneId: current.state.workspace.activeMilestoneId, milestones: Object.values(current.state.workspace.milestones).map(({ id, name, summary, handoff, thread, parts }) => ({ id, name, summary, handoff, archivedParts: parts.map((part, index) => ({ index, threadId: part.threadId, archivedAt: part.archivedAt })), threadId: id === current.state.workspace.activeMilestoneId ? current.state.partner.thread.threadId : thread?.threadId ?? null })), sessions: current.state.workspace.sessions };
}
export async function selectTaskRole(root, role, env = process.env) {
  if (!ROLE_NAMES.includes(role)) throw new Error(`role must be ${ROLE_NAMES.join(', ')}`);
  await mutate(root, 'session-task-role', state => {
    if (cycleBusy(state)) throw new Error('Select the task role before the independent review cycle.');
    const session = state.workspace.sessions[state.workspace.activeSessionId];
    if (!session) throw new Error('No bound session.');
    session.activeRole = role;
  }, env);
  return workspaceStatus(root, env);
}
export async function milestoneHandoff(root, reviewId, text, rotate = false, env = process.env) {
  if (!rotate && (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 8000)) throw new Error('handoff must be 1..8000 bytes');
  const state = await mutate(root, rotate ? 'milestone-linked-continuation' : 'milestone-reviewed-handoff', state => {
    if (cycleBusy(state)) throw new Error('Finish both review phases before a handoff or rotation.');
    const review = state.operations.find(op => op.id === reviewId && op.status === 'completed' && op.request.phase === 'reconcile');
    if (!review) throw new Error('A completed reconciliation operation is required; review the handoff in that cycle.');
    if (review.externalId !== state.partner.thread.threadId) throw new Error('Handoff review belongs to a different thread.');
    const milestone = state.workspace.milestones[state.workspace.activeMilestoneId];
    if (!rotate) { milestone.handoff = text; milestone.summary = text; milestone.reviewId = reviewId; return; }
    if (!milestone.handoff || milestone.reviewId !== reviewId) throw new Error('Save the reviewed handoff before rotating.');
    if (!state.partner.thread.threadId) throw new Error('No active thread to rotate.');
    milestone.parts.push({ ...structuredClone(state.partner.thread), archivedAt: new Date().toISOString() });
    state.partner.thread.threadId = null;
    state.partner.thread.checkpoint.nextAction = milestone.handoff;
    state.partner.thread.metadata.turnCount = 0;
    state.partner.thread.metadata.lastRecordedTurn = null;
    state.partner.thread.metadata.lastCompaction = null;
    milestone.thread = null;
  }, env);
  let archive = null, archiveWarning = null;
  try { archive = await saveChatReferences(root, state, env); } catch (error) { archiveWarning = error.message; }
  return { saved: true, rotated: rotate, milestone: state.workspace.activeMilestoneId, predecessorPreserved: true, archive, archiveWarning };
}
export function parseGauge(text, partial = false) {
  let last = null, compactions = 0;
  for (const line of text.split('\n')) try {
    const v = JSON.parse(line); if (v.type === 'compacted') compactions++;
    const info = v.payload?.info;
    if (v.payload?.type === 'token_count' && Number.isFinite(info?.last_token_usage?.input_tokens) && info.model_context_window > 0) last = { inputTokens: info.last_token_usage.input_tokens, windowTokens: info.model_context_window, at: v.timestamp, fraction: info.last_token_usage.input_tokens / info.model_context_window };
  } catch {}
  return { available: Boolean(last), lastCall: last, compactions, compactionCountCoverage: partial ? 'bounded tail only; not a lifetime count' : 'whole file', source: 'local rollout metadata; not live occupancy' };
}
export async function contextGauge(root, env = process.env) {
  const current = await readState(root, env); const id = current.state?.partner.thread.threadId;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return { available: false };
  // Discovery lists filenames, never scans transcript bodies. Bound both time and output.
  try {
    const base = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    const { stdout } = await exec('find', [base, '-type', 'f', '-name', `*${id}.jsonl`], { timeout: 1500, maxBuffer: 16384 });
    const files = stdout.trim().split('\n').filter(Boolean); if (files.length !== 1) return { available: false };
    const value = await tailText(files[0], 512 * 1024); return parseGauge(value.text, value.partial);
  } catch { return { available: false }; }
}
