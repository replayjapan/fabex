import { acquireLock } from './lock.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';

export const API_VERSION = 1;
export const activities = ['work', 'discussion', 'ask'];
const hash = value => createHash('sha256').update(value).digest('hex');
export const inside = (root, path) => { const r = relative(root, path); return r === '' || !r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r); };
export function dataRoot(env = process.env) { return resolve(env.MODES_HOME || (env.FABEX_HOME ? join(env.FABEX_HOME, 'modes') : join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins/data/modes'))); }
export async function canonical(root) { return realpath(root); }
export function hostActivity(mode) {
  return ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto'].includes(mode) ? 'work' : 'discussion';
}
export function validSession(id) { return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id); }
async function secureDirectory(path) {
  const parent = dirname(path);
  if (parent !== path) await secureDirectory(parent);
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Modes storage cannot use linked directories');
}
async function read(file) {
  let h;
  try {
    h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || s.size > 256 * 1024) throw new Error('Unsafe Modes state');
    return JSON.parse(await h.readFile('utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  finally { await h?.close(); }
}
async function paths(root, sessionId, env) {
  if (!validSession(sessionId)) throw new Error('Modes requires the host session identity');
  root = await canonical(root);
  const base = dataRoot(env);
  if (inside(root, base)) throw new Error('Modes storage must be outside the application');
  return { root, base, file: join(base, 'sessions', hash(sessionId) + '.json') };
}
export async function snapshot(root, sessionId, env = process.env) {
  const p = await paths(root, sessionId, env), value = await read(p.file);
  if (!value) return { apiVersion: API_VERSION, root: p.root, sessionId, activity: 'discussion', source: 'unknown', hostMode: null, generation: 0, installed: false };
  if (value.apiVersion !== API_VERSION || value.sessionId !== sessionId || typeof value.root !== 'string' || !activities.includes(value.activity) || !Number.isSafeInteger(value.generation) || typeof value.installed !== 'boolean' || !['host', 'modes', 'fabex-alias'].includes(value.source)) throw new Error('Invalid Modes permission evidence');
  // Subdirectory invocations reuse the session binding; unrelated projects cannot.
  if (!inside(value.root, p.root) && !inside(p.root, value.root)) throw new Error('Modes session belongs to another project');
  const effective = value.hostMode && hostActivity(value.hostMode) === 'work' ? value.activity : 'discussion';
  return { ...value, selectedActivity: value.activity, activity: effective };
}
async function change(root, sessionId, env, fn) {
  const p = await paths(root, sessionId, env);
  await secureDirectory(dirname(p.file));
  const release = await acquireLock(p.file + '.lock');
  const temp = p.file + '.' + randomUUID();
  try {
    const prior = await snapshot(root, sessionId, env);
    const state = { ...prior, activity: prior.selectedActivity ?? prior.activity };
    delete state.selectedActivity;
    await fn(state);
    if (state.source === 'unknown') state.source = 'host';
    state.generation++;
    const h = await open(temp, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(state)); await h.sync(); } finally { await h.close(); }
    await rename(temp, p.file);
    return snapshot(root, sessionId, env);
  } finally { await unlink(temp).catch(() => {}); await release(); }
}
export async function observeHost(root, input, env = process.env, installed = false, fabexRoot = null, providerRoot = null, legacy = null) {
  return change(root, input.session_id, env, s => {
    if (['unknown','host'].includes(s.source) && !s.legacyImported && legacy && activities.includes(legacy.activity)) { s.legacyImported = true; s.activity = legacy.activity; s.returnTo = legacy.returnTo ?? null; s.source = 'fabex-alias'; s.askHasQuestion = legacy.askHasQuestion === true; }
    s.installed ||= installed;
    if (fabexRoot) { s.fabexRoot = fabexRoot; s.fabexProjectRoot = root; }
    if (providerRoot) s.providerRoot = providerRoot;
    // Missing evidence never resurrects prior write permission.
    s.hostMode = typeof input.permission_mode === 'string' ? input.permission_mode : null;
    if (s.source === 'unknown' || s.source === 'host') { s.source = 'host'; s.activity = hostActivity(s.hostMode); }
    s.observedAt = new Date().toISOString();
  });
}
export async function ownerTransition(root, input, activity, env = process.env, source = 'modes') {
  const prefix = source === 'modes' ? 'modes' : 'fabex';
  if (!activities.includes(activity) || input.agent_id || input.agent_type || input.expansion_type !== 'slash_command' || input.command_source !== 'plugin' || !new RegExp(`^/?${prefix}:(?:work(?:Claude)?|discussion(?:Claude|Codex)?|ask(?:Claude|Codex)?)$`).test(input.command_name ?? '')) throw new Error('Modes changes require an owner-typed plugin command');
  const named = (input.command_name ?? '').replace(/^\//, '').split(':')[1]?.replace(/(?:Claude|Codex)$/, '');
  if (named !== activity) throw new Error('Owner command activity does not match the requested transition');
  return change(root, input.session_id, env, s => {
    const grant = { id: randomUUID(), sessionId: input.session_id, activity };
    // Issue and consume the owner grant in the same locked hook transaction.
    // No assistant-controlled command can mint, change or replay this grant.
    if (s.lastExpansionId && input.event_id && s.lastExpansionId === input.event_id) return;
    s.hostMode = typeof input.permission_mode === 'string' ? input.permission_mode : null;
    s.returnTo = activity === 'ask' ? (s.activity === 'ask' ? s.returnTo : s.activity) ?? 'discussion' : null;
    s.activity = grant.activity; s.source = source; s.installed ||= source === 'modes';
    s.askHasQuestion = activity === 'ask' && Boolean(input.command_args?.trim());
    s.lastExpansionId = input.event_id ?? null;
    s.transitionId = grant.id;
  });
}
export async function ownerPrompt(root, input, env = process.env, observer = 'modes') {
  if (input.agent_id || input.agent_type || typeof input.prompt !== 'string' || /<task-notification>|\[SYSTEM NOTIFICATION|<system-reminder>|<local-command-caveat>|^\s*(?:<agent-message(?:\s|>)|\[Subagent hand-back\])/i.test(input.prompt) || /^\s*\/(?:modes|fabex):/.test(input.prompt)) return snapshot(root, input.session_id, env);
  return change(root, input.session_id, env, s => {
    const id = input.message_id ?? input.prompt_id;
    const fingerprint = hash(input.prompt);
    if (id && s.lastPromptId === id && s.promptFingerprint === fingerprint) return;
    if (!id && s.promptFingerprint === fingerprint && !(s.promptObservers ?? []).includes(observer)) { s.promptObservers = [...(s.promptObservers ?? []), observer]; return; }
    s.lastPromptId = id ?? null; s.promptFingerprint = fingerprint; s.promptObservers = [observer];
    if (s.activity === 'ask') {
      if (s.askHasQuestion) { s.activity = s.returnTo ?? 'discussion'; s.returnTo = null; }
      else s.askHasQuestion = true;
    }
  });
}

export async function recordHelper(root, input, env = process.env) {
  if (input.hook_event_name !== 'SubagentStart' || typeof input.agent_id !== 'string') return;
  return change(root, input.session_id, env, s => { s.helpers = [...new Set([...(s.helpers ?? []), input.agent_id])].slice(-128); });
}
