import { isDeepStrictEqual } from 'node:util';
import { discoverTracker } from './tracker-discovery.mjs';
import { availableModels } from './model-catalog.mjs';
import { startSettingsMenu, advanceSettingsMenu, menuSummary, typedSettingsReference } from './settings-menu.mjs';
import { claudeModelSource, codexModelSource } from './speakers.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { open, readFile, mkdir, writeFile, rename, realpath, lstat, readdir } from 'node:fs/promises';
import { fullTitle, indexedGauge } from './transcript-index.mjs';
import { resolve, dirname, join, basename } from 'node:path';
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
  const archiveRoot = join(base, 'chats');
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  if (await realpath(archiveRoot) !== archiveRoot) throw new Error('private archive root must not be a symlink');
  const matches = (await readdir(archiveRoot)).filter(name => name.endsWith(`--${m.id}`));
  let folder = join(archiveRoot, `${slug}--${m.id}`);
  // Preserve older duplicate exports intact inside the canonical directory.
  // Never trust a suffix alone: verify each record before moving anything.
  for (const name of matches) {
    const path = join(archiveRoot, name), info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('archive is not an ordinary directory');
    const ref = join(path, 'references.json');
    if ((await lstat(ref)).isSymbolicLink() || JSON.parse(await readFile(ref, 'utf8')).milestoneId !== m.id) throw new Error('archive identity mismatch; nothing removed');
  }
  if (matches.length) {
    const chosen = matches.includes(`${slug}--${m.id}`) ? `${slug}--${m.id}` : matches[0];
    const previous = join(archiveRoot, chosen), info = await lstat(previous);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('archive is not an ordinary directory');
    if (previous !== folder) await rename(previous, folder);
    for (const name of matches.filter(name => name !== chosen)) {
      const history = join(folder, 'previous-exports');
      await mkdir(history, { recursive: true, mode: 0o700 });
      if (await realpath(history) !== history) throw new Error('archive history must not be a symlink');
      await rename(join(archiveRoot, name), join(history, randomUUID()));
    }
  }
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
  let title = null;
  if (input.transcript_path) try {
    title = titleFromText((await tailText(input.transcript_path)).text, sessionId);
    const current = await readState(root, env);
    if (!title && !current.state?.workspace?.sessions?.[sessionId]) title = await fullTitle(input.transcript_path, sessionId);
  } catch {}
  const state = await mutate(root, 'workspace-session-binding', state => {
    const w = state.workspace;
    let session = w.sessions[sessionId];
    if (!session) {
      const id = w.activeMilestoneId;
      session = w.sessions[sessionId] = { milestoneId: id, title: title ?? sessionId, transcriptPath: input.transcript_path ?? null, settings: {} };
    }
    if (title) {
      session.title = title;
    }
    if (input.transcript_path) session.transcriptPath = input.transcript_path;
    if (!(cycleBusy(state) && w.activeSessionId !== sessionId)) bind(state, session.milestoneId, sessionId);
  }, env);
  try { await saveChatReferences(root, state, env); } catch (error) { state.archiveWarning = `Chat references not exported: ${error.message}`; }
  if (state.workspace.activeSessionId !== sessionId) state.archiveWarning = `${state.archiveWarning ?? ''} This chat is registered; its thread and execution settings bind when its queued cycle starts.`;
  return state;
}
export async function issueWorkspaceGrant(root, input, env = process.env, { catalog = availableModels } = {}) {
  const command = input.command_name?.replace(/^\//, '').replace(/^fabex:/, '');
  if (!['settings', 'milestone'].includes(command)) return null;
  const args = (input.command_args ?? '').trim();
  if (!args && (command !== 'settings' || input.expansion_type !== 'slash_command' || input.command_source !== 'plugin')) return { viewing: true };
  if (args === '--json' && command === 'settings') return { viewing: true };
  if (input.expansion_type !== 'slash_command' || input.command_source !== 'plugin' || !input.session_id) throw new Error('Settings changes require an owner-typed slash command.');
  const grant = { id: randomUUID(), command, args, sessionId: input.session_id, expiresAt: Date.now() + 300000 };
  const config = (await loadEffectiveConfig(root, env)).config;
  let before = await readState(root, env);
  if (before.ok && !before.state.workspace.sessions[input.session_id]) {
    // A resumed pre-upgrade chat may not have run the new SessionStart hook yet.
    // Only the verified owner slash command above can register it here.
    await registerSession(root, { session_id: input.session_id }, env);
    before = await readState(root, env);
  }
  const resolvedModel = before.ok ? resolveSettings(config, before.state, input.session_id).values['partners.codex.model'] : null;
  const defaultModel = await codexModelSource({ ...config, models: { ...config.models, codex: { ...config.models.codex, model: resolvedModel } } }, env);
  const claude = await claudeModelSource(before.state?.claudeModel?.sessionId === input.session_id ? before.state.claudeModel : null, env);
  const modelCatalog = command === 'settings' && !args ? await catalog(root, env) : { models: [], error: null };
  await mutate(root, 'workspace-owner-grant', state => {
    const session = state.workspace.sessions[input.session_id];
    if (!session) throw new Error('Session not registered; submit a normal owner message first.');
    grant.milestoneId = session.milestoneId;
    if (command === 'settings' && (!args || /^tracking=(on|off|inherit)$/.test(args))) {
      const { values } = resolveSettings(config, state, input.session_id);
      Object.assign(grant, startSettingsMenu(args, { project: basename(root), milestone: session.milestoneId === 'legacy' ? null : state.workspace.milestones[session.milestoneId].name, models: modelCatalog.models, catalogError: modelCatalog.error, values, defaultModel: defaultModel.id, claude: `${claude.id ?? 'Unknown'} (${claude.source})` }));
      grant.selection = null;
      grant.questionToolId = null;
      for (const [id, previous] of Object.entries(state.workspace.grants)) if (previous.questions && previous.sessionId === grant.sessionId) delete state.workspace.grants[id];
    }
    for (const [id, value] of Object.entries(state.workspace.grants)) if (value.expiresAt < Date.now()) delete state.workspace.grants[id];
    state.workspace.grants[grant.id] = grant;
  }, env);
  return grant;
}
export function matchesWorkspaceQuestion(state, sessionId, questions) {
  return Object.values(state.workspace?.grants ?? {}).some(grant => grant.command === 'settings' && grant.questions
    && grant.sessionId === sessionId && grant.expiresAt >= Date.now() && !grant.selection
    && state.workspace.sessions[sessionId]?.milestoneId === grant.milestoneId
    && isDeepStrictEqual(questions, grant.questions));
}
export async function recordWorkspaceQuestion(root, input, env = process.env) {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'AskUserQuestion' || input.agent_id || input.agent_type || !input.session_id || !input.tool_use_id) return;
  const current = await readState(root, env);
  const matches = grant => grant.questions && grant.sessionId === input.session_id && grant.expiresAt >= Date.now() && !grant.selection && isDeepStrictEqual(input.tool_input?.questions, grant.questions);
  if (!current.ok || !Object.values(current.state.workspace.grants).some(matches)) return;
  await mutate(root, 'workspace-owner-question', state => {
    for (const grant of Object.values(state.workspace.grants)) if (matches(grant) && state.workspace.sessions[grant.sessionId]?.milestoneId === grant.milestoneId) grant.questionToolId = input.tool_use_id;
  }, env);
}
export async function recordWorkspaceSelection(root, input, env = process.env) {
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'AskUserQuestion' || input.agent_id || input.agent_type || !input.session_id || !input.tool_use_id) return null;
  let response = input.tool_response;
  if (typeof response === 'string') { try { response = JSON.parse(response); } catch { return null; } }
  if (!response?.answers || response.is_error || response.error) return null;
  let selected = null;
  await mutate(root, 'workspace-owner-selection', state => {
    for (const grant of Object.values(state.workspace.grants)) {
      if (!grant.questions || grant.questionToolId !== input.tool_use_id || grant.sessionId !== input.session_id || grant.expiresAt < Date.now() || grant.selection || !isDeepStrictEqual(input.tool_input?.questions, grant.questions)) continue;
      if (state.workspace.sessions[grant.sessionId]?.milestoneId !== grant.milestoneId) continue;
      if (grant.flow) {
        if (![2, 3, 4].includes(grant.flow.version)) continue;
        const next = advanceSettingsMenu(grant, response.answers);
        if (next) { selected = { grantId: grant.id, ...next }; if (next.cancelled) delete state.workspace.grants[grant.id]; }
        continue;
      }
      const labels = grant.questions.map(q => response.answers[q.question]);
      if (labels.some((label, i) => typeof label !== 'string' || !grant.questions[i].options.some(o => o.label === label))) continue;
      const scope = labels[0] === 'Project' ? 'project' : 'milestone';
      const mode = grant.args ? grant.args.split('=')[1] : ({ On: 'on', Off: 'off', Inherit: 'inherit' })[labels[1]];
      const pick = `tracking=${mode} scope=${scope}`;
      if (!grant.options.includes(pick)) continue;
      grant.selection = pick; selected = { grantId: grant.id, selection: pick };
    }
  }, env);
  return selected;
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
    const index = token.indexOf('='); if (index < 1) throw new Error('Use key=value scope=session|milestone|project; value=inherit removes an override.');
    const original = token.slice(0, index), key = original === 'tracking' ? 'usageTracker.mode' : original, raw = token.slice(index + 1);
    if (key === 'scope') { if (!['session', 'milestone', 'project'].includes(raw)) throw new Error('scope must be session, milestone or project'); result.scope = raw; continue; }
    if (key === 'milestones.newChatMeansNewMilestone' && raw !== 'inherit') throw new Error('Retired: milestones follow your plan, not new chats.');
    const keys = /^roles\.testing\.(executor|model|effort)$/.test(key) ? ['testWriting', 'testRunning'].map(role => key.replace('testing', role)) : [key];
    if (keys.some(k => !Object.hasOwn(SETTING_DEFAULTS, k))) throw new Error(`unknown setting ${key}`);
    let value; try { value = JSON.parse(raw); } catch { value = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw; }
    for (const k of keys) { if (raw === 'inherit') result.resets.push(k); else { validateSettings({ [k]: value }); result.updates[k] = value; } }
  }
  return result;
}
export async function applyWorkspaceGrant(root, grantId, env = process.env) {
  const config = (await loadEffectiveConfig(root, env)).config;
  const before = await readState(root, env); if (!before.ok) throw new Error(before.health);
  const grant = before.state.workspace.grants[grantId];
  if (!grant || grant.expiresAt < Date.now()) throw new Error('owner settings grant missing or expired');
  if (cycleBusy(before.state)) throw new Error('Apply settings between completed review cycles.');
  if (grant.flow && (![2, 3, 4].includes(grant.flow.version) || !grant.selection)) throw new Error('Choose and apply a setting in the owner dialog, or type an explicit scoped command.');
  if (grant.options && (!grant.selection || !grant.options.includes(grant.selection))) throw new Error('Choose an offered setting in the owner dialog, or type an explicit scoped settings command.');
  const parsed = grant.command === 'settings' ? parseSettingsArgs(grant.selection ?? grant.args) : null;
  const state = await mutate(root, 'workspace-apply-owner-grant', async state => {
    const w = state.workspace, current = w.grants[grantId];
    if (!current || current.expiresAt < Date.now() || cycleBusy(state)) throw new Error('settings grant expired or cycle started; retry safely');
    if (!isDeepStrictEqual(current, grant)) throw new Error('settings grant changed; retry safely');
    if (state.route === 'recovery-read-only' && grant.command !== 'settings') throw new Error('Recover the current thread before changing milestones; a milestone is not a recovery action.');
    const session = w.sessions[grant.sessionId]; if (!session) throw new Error('session not registered; submit a normal owner message first');
    if (grant.milestoneId && session.milestoneId !== grant.milestoneId) throw new Error('The selected milestone changed; open settings again.');
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
      if (parsed.scope === 'session' || parsed.scope === 'milestone') {
        const target = parsed.scope === 'session' ? session.settings : (w.milestones[session.milestoneId].settings ??= {});
        Object.assign(target, parsed.updates); for (const key of parsed.resets) delete target[key];
      }
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
      if (!matches.length) w.milestones[id] = { id, name, nameSource: 'owner', thread: null, summary: '', handoff: '', createdAt: new Date().toISOString(), parts: [] };
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
  return { applied: true, ...(grant.flow ? { summary: menuSummary(grant.flow) } : {}), ...resolveSettings((await loadEffectiveConfig(root, env)).config, state, grant.sessionId), milestone: state.workspace.activeMilestoneId, note: 'Saved for the selected scope. Effective values below include any more specific overrides. Model/effort requests apply on the next applicable turn; Claude main controls remain host-managed. No Git action is authorized.' };
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
  const resolved = resolveSettings(config, current.state, sessionId);
  const milestoneId = current.state.workspace.sessions[resolved.sessionId]?.milestoneId ?? current.state.workspace.activeMilestoneId;
  const milestone = current.state.workspace.milestones[milestoneId];
  return { ...resolved, typedCommands: typedSettingsReference(), models: { claude: await claudeModelSource(current.state.claudeModel?.sessionId === resolved.sessionId ? current.state.claudeModel : null, env), codex: await codexModelSource({ ...config, models: { ...config.models, codex: { ...config.models.codex, model: resolved.values['partners.codex.model'] } } }, env) }, project: root, milestone: { id: milestoneId, name: milestone.name }, tracking: { installation: await discoverTracker(resolved.values, env), project: config.settings?.['usageTracker.mode'] ?? 'off', milestone: milestone.settings?.['usageTracker.mode'] ?? 'inherit', session: current.state.workspace.sessions[resolved.sessionId]?.settings?.['usageTracker.mode'] ?? 'inherit', effective: resolved.values['usageTracker.mode'], source: resolved.sources['usageTracker.mode'] }, execution: executionPlan(config, current.state, sessionId), observations: current.state.workspace.observations ?? {}, activeMilestoneId: current.state.workspace.activeMilestoneId, milestones: Object.values(current.state.workspace.milestones).map(({ id, name, summary, handoff, thread, parts }) => ({ id, name, summary, handoff, archivedParts: parts.map((part, index) => ({ index, threadId: part.threadId, archivedAt: part.archivedAt })), threadId: id === current.state.workspace.activeMilestoneId ? current.state.partner.thread.threadId : thread?.threadId ?? null })), sessions: current.state.workspace.sessions };
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
    return await indexedGauge(root, files[0], env);
  } catch { return { available: false }; }
}
