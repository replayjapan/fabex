import { dispositionSchema, validDisposition } from './work-disposition.mjs';
// Only owner-facing output is retained here; reasoning and tool events are excluded.
const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const texts = { type: 'array', items: text };
export function reviewSchema(phase) {
  const properties = {
    scopeMismatch: nullableText, parityConcern: nullableText, answer: text,
    evidence: texts, assumptions: texts, uncertainties: texts,
    ...(phase === 'reconcile' ? { disagreements: texts, workDisposition: { anyOf: [dispositionSchema, { type: 'null' }] } } : {}),
    recommendation: nullableText, changedFiles: texts,
    tests: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { command: text, exitCode: { type: ['integer', 'null'] } }, required: ['command', 'exitCode'] } }
  };
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

export function validReview(value, phase, { allowLegacy = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(reviewSchema(phase).properties).sort();
  if (allowLegacy && Object.hasOwn(value, 'ownerSummary')) keys.push('ownerSummary');
  keys.sort();
  if (allowLegacy && phase === 'reconcile' && !Object.hasOwn(value, 'workDisposition')) keys.splice(keys.indexOf('workDisposition'), 1);
  if (Object.hasOwn(value, 'workDisposition') && value.workDisposition !== null && !validDisposition(value.workDisposition)) return false;
  if (Object.keys(value).sort().join(',') !== keys.join(',')) return false;
  if (Object.hasOwn(value, 'ownerSummary') && !validSummary(value.ownerSummary)) return false;
  if (typeof value.answer !== 'string' || !value.answer.trim()) return false;
  const isText = (s) => typeof s === 'string';
  if (['scopeMismatch', 'parityConcern', 'recommendation'].some((key) => value[key] !== null && !isText(value[key]))) return false;
  if (['evidence', 'assumptions', 'uncertainties', 'changedFiles', ...(phase === 'reconcile' ? ['disagreements'] : [])].some((key) => !Array.isArray(value[key]) || !value[key].every(isText))) return false;
  if (!Array.isArray(value.tests) || !value.tests.every((item) => item && Object.keys(item).sort().join(',') === 'command,exitCode' && isText(item.command) && (item.exitCode === null || Number.isSafeInteger(item.exitCode)))) return false;
  return true;
}

export function parseReview(raw, phase) {
  try {
    const value = JSON.parse(raw);
    if (validReview(value, phase)) return { finalResponse: value.answer, structured: value, warning: null };
  } catch {}
  return { finalResponse: raw, structured: null, warning: 'Structured review unavailable: Codex returned malformed output; relay the stored answer verbatim.' };
}

export function validSummary(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

// Legacy ownerSummary remains readable, but is never substituted for the answer.
export function relayBlock(operation, { full = false } = {}) {
  const answer = operation.result.finalResponse;
  if (typeof answer !== 'string') return operation.result.warning ? `Fabex warning: ${operation.result.warning}` : null;
  const label = operation.result.relay?.label ?? 'Codex:';
  const fields = operation.result.structured;
  const flags = [];
  for (const [key, title] of [['scopeMismatch', 'Scope mismatch'], ['parityConcern', 'Parity concern'], ['disagreements', 'Disagreement'], ['uncertainties', 'Uncertainty']]) {
    for (const value of [fields?.[key]].flat()) {
      if (typeof value === 'string' && value.trim()) flags.push(`${title}: ${value}`);
    }
  }
  return `${label}\n\n${answer}${flags.length ? `\n\n${flags.join('\n')}` : ''}${operation.result.warning ? `\n\nFabex warning: ${operation.result.warning}` : ''}`;
}

export function normalizeRelay(text) {
  return String(text ?? '').replace(/^\s*(?:>\s*)+/gm, '').replace(/\s+/gu, ' ').trim();
}

export function pendingRelays(state, sessionId) {
  return state.operations.filter((op) => op.status === 'completed' && op.result?.relay?.status === 'pending'
    && (!op.result.relay.sessionId || op.result.relay.sessionId === sessionId));
}

export function missingRelays(state, input) {
  const visible = normalizeRelay(input.last_assistant_message);
  const pending = pendingRelays(state, input.session_id);
  // A later answer does not deliver an unread earlier answer. Verify each full
  // answer and its flags separately; no summary or Phase 2 substitution.
  return pending.filter(op => !visible.includes(normalizeRelay(relayBlock(op))));
}
