export const PARTICIPANTS = new Set(['both', 'claude', 'codex']);

const LABELS = new Map([
  ['normal:both', 'work'],
  ['normal:claude', 'workClaude'],
  ['discussion:both', 'discussion'],
  ['discussion:claude', 'discussionClaude'],
  ['discussion:codex', 'discussionCodex'],
  ['ask-once:both', 'ask'],
  ['ask-once:claude', 'askClaude'],
  ['ask-once:codex', 'askCodex'],
  ['recovery-read-only:both', 'recovery-read-only']
]);

export function formatMode(route, participants) {
  const label = LABELS.get(`${route}:${participants}`);
  if (!label) throw new Error(`invalid Fabex mode combination: ${route}/${participants}`);
  return label;
}

export function isValidMode(route, participants) {
  return LABELS.has(`${route}:${participants}`);
}

export function describeMode(route, participants) {
  if (route === 'recovery-read-only') return 'Read-only; recovery required.';
  if (route === 'normal' && participants === 'both') return 'Normal permissions; Claude and Codex participate.';
  if (route === 'normal' && participants === 'claude') return 'Normal permissions; Claude answers alone; Codex still implements.';
  const scope = route === 'ask-once' ? 'One-shot read-only' : 'Read-only';
  if (participants === 'both') return `${scope}; Claude and Codex participate.`;
  if (participants === 'claude') return `${scope}; Claude participates.`;
  return `${scope}; Codex participates.`;
}

export function formatModeTransition(from, to) {
  const previous = formatMode(from.route, from.participants);
  const next = formatMode(to.route, to.participants);
  const prefix = previous === next ? `Fabex mode unchanged: ${next}.` : `Fabex mode: ${previous} -> ${next}.`;
  return `${prefix} ${describeMode(to.route, to.participants)}`;
}

export function replyBadgeInstruction(label, setting) {
  if (setting === 'always') return `Prefix every reply with [Fabex: ${label}].`;
  if (setting === 'changes') return `Prefix a mode-transition reply with [Fabex: ${label}]; omit the badge otherwise.`;
  return 'Do not add a Fabex reply badge.';
}
