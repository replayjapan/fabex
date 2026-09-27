// Flat, validated settings keep inheritance and provenance unambiguous.
export const ROLE_NAMES = ['implementation', 'testWriting', 'testRunning', 'imageReview', 'docs', 'gitDelivery'];
export const SETTING_DEFAULTS = {
  'partners.codex.model': null, 'partners.codex.effort': null,
  'partners.codex.helperServers': 'inherit',
  'partners.claude.model': null, 'partners.claude.effort': null,
  'milestones.newChatMeansNewMilestone': false, 'context.reviewAfterCompactions': 3,
  summaries: true, 'usageTracker.mode': 'off', 'usageTracker.path': null,
  'usageTracker.progressMinutes': 120,
  ...Object.fromEntries(ROLE_NAMES.flatMap(role => [
    [`roles.${role}.executor`, ['testRunning', 'gitDelivery'].includes(role) ? 'claude' : 'codex'],
    [`roles.${role}.model`, null], [`roles.${role}.effort`, null]
  ]))
};
export function validateSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('settings must be an object');
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(SETTING_DEFAULTS, key)) throw new Error(`unknown setting ${key}; choices: ${Object.keys(SETTING_DEFAULTS).join(', ')}`);
    let valid;
    if (key.endsWith('.executor')) valid = ['claude', 'codex'].includes(value);
    else if (key.endsWith('.effort')) valid = value === null || ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].includes(value);
    else if (key.endsWith('.model')) valid = value === null || typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
    else if (key === 'partners.codex.helperServers') valid = ['inherit', 'off'].includes(value);
    else if (key === 'usageTracker.mode') valid = ['inherit', 'on', 'off'].includes(value);
    else if (key === 'usageTracker.path') valid = value === null || typeof value === 'string' && value.startsWith('/') && value.length < 4096 && !/[\0\n\r]/.test(value);
    else if (key === 'context.reviewAfterCompactions') valid = Number.isInteger(value) && value >= 1 && value <= 100;
    else if (key === 'usageTracker.progressMinutes') valid = Number.isInteger(value) && value >= 15 && value <= 1440;
    else valid = typeof value === 'boolean';
    if (!valid) throw new Error(`invalid value for ${key}`);
  }
  return values;
}
export function resolveSettings(config, state, sessionId = state.workspace?.activeSessionId) {
  const values = { ...SETTING_DEFAULTS, 'partners.codex.model': config?.models?.codex?.model ?? null, 'partners.codex.effort': config?.models?.codex?.reasoningEffort ?? null };
  const sources = Object.fromEntries(Object.keys(values).map(key => [key, 'plugin/legacy-config']));
  for (const [layer, name] of [[config?.settings, null], [state.workspace?.sessions?.[sessionId]?.settings, 'session']]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value === 'inherit' && key === 'usageTracker.mode') continue;
      values[key] = value; sources[key] = name ?? config.settingSources?.[key] ?? 'project';
    }
  }
  return { values, sources, sessionId: sessionId ?? null, modelVerification: 'Requested values are not proof of a served model. Claude main model/effort require host selection; unknown account availability is not an available-model catalog.' };
}
export function executionPlan(config, state, sessionId = state.workspace?.activeSessionId) {
  const { values } = resolveSettings(config, state, sessionId);
  const role = state.workspace?.sessions[sessionId]?.activeRole ?? 'implementation';
  return { role, executor: values[`roles.${role}.executor`], model: values[`roles.${role}.model`], effort: values[`roles.${role}.effort`] };
}
export function emptyWorkspace() {
  return { activeMilestoneId: 'legacy', activeSessionId: null, milestones: { legacy: { id: 'legacy', name: 'Legacy', thread: null, summary: '', handoff: '', createdAt: new Date().toISOString(), parts: [] } }, sessions: {}, grants: {}, seals: {}, usageMarkers: {} };
}
export function validateWorkspace(w) {
  if (!w || !w.milestones?.[w.activeMilestoneId] || !w.sessions || !w.grants || !w.seals || !w.usageMarkers) throw new Error('invalid workspace registry');
  if (Object.keys(w.milestones).length > 100 || Object.keys(w.sessions).length > 256 || Buffer.byteLength(JSON.stringify(w)) > 600 * 1024) throw new Error('workspace registry capacity exceeded; preserve/export history before adding more');
  for (const session of Object.values(w.sessions)) { if (!w.milestones[session.milestoneId]) throw new Error('unknown session milestone'); if (session.activeRole && !ROLE_NAMES.includes(session.activeRole)) throw new Error('invalid task role'); validateSettings(session.settings); }
  for (const map of [w.milestones, w.sessions, w.grants, w.seals, w.usageMarkers]) {
    if (typeof map !== 'object' || Array.isArray(map) || Object.keys(map).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('invalid private registry map');
  }
  for (const [id, m] of Object.entries(w.milestones)) {
    if (id !== 'legacy' && !/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid milestone id');
    if (m.id !== id || typeof m.name !== 'string' || m.name.length > 200 || typeof m.handoff !== 'string' || typeof m.summary !== 'string' || !Array.isArray(m.parts)) throw new Error('invalid milestone record');
  }
  for (const session of Object.values(w.sessions)) for (const [id, profile] of Object.entries(session.profiles ?? {})) {
    if (!w.milestones[id] || !ROLE_NAMES.includes(profile.activeRole)) throw new Error('invalid saved milestone profile');
    validateSettings(profile.settings);
  }
  for (const grant of Object.values(w.grants)) if (!['settings', 'milestone'].includes(grant.command) || typeof grant.sessionId !== 'string' || typeof grant.args !== 'string' || !Number.isFinite(grant.expiresAt)) throw new Error('invalid owner settings grant');
  for (const seal of Object.values(w.seals)) if (seal.reading !== null && (typeof seal.reading !== 'string' || Buffer.byteLength(seal.reading) > 16000 || !/^[a-f0-9]{64}$/.test(seal.digest))) throw new Error('invalid independent seal');
}
