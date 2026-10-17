// Compatibility distribution of the Modes-owned API. No dynamic sibling imports.
import { observeHost, ownerTransition, ownerPrompt, snapshot, validSession, canonical }  from '../vendor/modes/state.mjs';
import { classify, researchRoot } from '../vendor/modes/policy.mjs';
import { readPrivate, sidecar, changePrivate } from './private-store.mjs';
import { resolve, extname, basename, relative } from 'node:path';
import { isDocumentationTarget, isTestTarget } from './authorship.mjs';
import { fileURLToPath } from 'node:url';
export { researchRoot };
// Modes owns activities. Standalone Fabex follows observed host permission evidence.
export async function activitySnapshot(root, sessionId, env = process.env) {
  const neutral = { root: await canonical(root), activity: 'discussion', source: 'host-unknown', installed: false, active: true, generation: 0 };
  if (!validSession(sessionId)) return neutral;
  const permission = await snapshot(root, sessionId, env);
  if (permission.installed) return { ...permission, active: true };
  const host = await readPrivate(await sidecar(root, 'host-permissions.json', env), { sessions: {} });
  const mode = host.sessions?.[sessionId];
  return { ...neutral, activity: ['default','acceptEdits','bypassPermissions','dontAsk','auto'].includes(mode) ? 'work' : 'discussion', source: mode ? `host-${mode}` : 'host-unknown' };
}
export async function observeActivity(root, input, env = process.env) {
  if (!validSession(input.session_id)) return activitySnapshot(root, null, env);
  // Retain an observed plan restriction across payloads which omit permission_mode.
  if (typeof input.permission_mode === 'string') await changePrivate(root, 'host-permissions.json', { sessions: {} }, data => {
    if (input.permission_mode === 'plan') data.sessions[input.session_id] = 'plan';
    else if (['default','acceptEdits','bypassPermissions','dontAsk','auto'].includes(input.permission_mode)) data.sessions[input.session_id] = input.permission_mode;
    else data.sessions[input.session_id] = 'unknown';
  }, env);
  const prior = await snapshot(root, input.session_id, env);
  if (prior.installed) await observeHost(root, input, env, false, fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''));
  // Permission observations constrain subsequent work; they never cancel an
  // already-running partner turn. Stopping is an explicit controller action.
  return activitySnapshot(root, input.session_id, env);
}
export async function aliasActivity(root, input, env = process.env) {
  const route = (input.command_name ?? '').replace(/^\//, '').match(/^modes:(work|discussion|ask)$/)?.[1];
  if (!route || !validSession(input.session_id)) return null;
  const modesCommand = input.command_name.replace(/^\//, '').startsWith('modes:');
  if (!modesCommand && !(await snapshot(root, input.session_id, env)).installed) return null;
  return ownerTransition(root, input, route, env, modesCommand ? 'modes' : 'fabex-alias');
}
export async function promptActivity(root, input, env = process.env) {
  if (!validSession(input.session_id) || !(await snapshot(root, input.session_id, env)).installed) return null;
  return ownerPrompt(root, input, env, 'fabex');
}
export async function activityDecision(root, sessionId, toolName, toolInput, env, ownHelper = false) {
  const permission = await activitySnapshot(root, sessionId, env);
  return { permission, ...(permission.installed ? classify({ toolName, toolInput, permission, ownHelper }) : { decision: 'defer' }) };
}

// Containment and authorship are separate: Modes bounds effects, Fabex assigns
// who may produce the source or text inside those bounds.
export function researchAuthorAllowed(root, target, rights, actor) {
  if (typeof target !== 'string') return false;
  const absolute = resolve(root, target), area = absolute.startsWith(researchRoot(root) + '/') ? researchRoot(root) : root;
  const relativeName = relative(area, absolute);
  const researchText = area !== root && relativeName && !relativeName.split('/').some(p => p.startsWith('.')) && ['.md', '.txt'].includes(extname(absolute)) && !['AGENTS.MD','CLAUDE.MD','SKILL.MD'].includes(basename(absolute).toUpperCase());
  if ((isDocumentationTarget(absolute, area) || researchText) && rights[actor + 'Documents']) return true;
  if (isTestTarget(absolute, area)) return rights.testWriter === actor;
  return rights.coder === actor;
}
