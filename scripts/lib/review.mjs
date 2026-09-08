// Only owner-facing output is retained here; reasoning and tool events are excluded.
const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const texts = { type: 'array', items: text };
export function reviewSchema(phase) {
  const properties = {
    scopeMismatch: nullableText, parityConcern: nullableText, answer: text, ownerSummary: text,
    evidence: texts, assumptions: texts, uncertainties: texts,
    ...(phase === 'reconcile' ? { disagreements: texts } : {}),
    recommendation: nullableText, changedFiles: texts,
    tests: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { command: text, exitCode: { type: ['integer', 'null'] } }, required: ['command', 'exitCode'] } }
  };
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

export function validReview(value, phase, { allowLegacy = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(reviewSchema(phase).properties).sort();
  if (allowLegacy && !Object.hasOwn(value, 'ownerSummary')) keys.splice(keys.indexOf('ownerSummary'), 1);
  if (Object.keys(value).sort().join(',') !== keys.join(',')) return false;
  if (Object.hasOwn(value, 'ownerSummary') && !validSummary(value.ownerSummary)) return false;
  if (typeof value.answer !== 'string' || !value.answer.trim() || Buffer.byteLength(value.answer) > 32768) return false;
  const bounded = (s) => typeof s === 'string' && Buffer.byteLength(s) <= 2048;
  if (['scopeMismatch', 'parityConcern', 'recommendation'].some((key) => value[key] !== null && !bounded(value[key]))) return false;
  if (['evidence', 'assumptions', 'uncertainties', 'changedFiles', ...(phase === 'reconcile' ? ['disagreements'] : [])].some((key) => !Array.isArray(value[key]) || value[key].length > 16 || !value[key].every(bounded))) return false;
  if (!Array.isArray(value.tests) || value.tests.length > 16 || !value.tests.every((item) => item && Object.keys(item).sort().join(',') === 'command,exitCode' && bounded(item.command) && (item.exitCode === null || Number.isSafeInteger(item.exitCode)))) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 48 * 1024;
}

export function parseReview(raw, phase) {
  try {
    const value = JSON.parse(raw);
    if (validReview(value, phase)) return { finalResponse: value.answer, structured: value, warning: null };
  } catch {}
  return { finalResponse: raw, structured: null, warning: 'Structured review unavailable: Codex returned malformed or over-budget output; relay the stored answer verbatim.' };
}

export function validSummary(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 1200;
}

export function relayBlock(operation, { full = false } = {}) {
  const answer = operation.result.finalResponse;
  if (typeof answer !== 'string') return null;
  const label = operation.result.relay?.label ?? 'Codex:';
  const phase = operation.request.phase === 'independent' ? 'Phase 1 — independent' : operation.request.phase === 'reconcile' ? 'Phase 2 — reconciliation/corrections' : 'Answer';
  const fields = operation.result.structured;
  const flags = [];
  for (const [key, title] of [['scopeMismatch', 'Scope mismatch'], ['parityConcern', 'Parity concern'], ['disagreements', 'Disagreement'], ['uncertainties', 'Uncertainty']]) {
    for (const value of [fields?.[key]].flat()) {
      if (typeof value === 'string' && value.trim()) flags.push(`- ${title}: ${value.replace(/\s+/gu, ' ').trim()}`);
    }
  }
  const summary = validSummary(fields?.ownerSummary) ? fields.ownerSummary : null;
  if (full) return `${label} ${phase}\n\n${answer.split('\n').map((line) => `> ${line}`).join('\n')}${flags.length ? `\n\nCodex flags:\n\n${flags.join('\n')}` : ''}${operation.result.warning ? `\n\nFabex warning: ${operation.result.warning}` : ''}`;
  const differed = operation.request.phase === 'reconcile' && (fields?.scopeMismatch?.trim() || fields?.disagreements?.some(value => value.trim()));
  // A disagreement can be with Claude rather than with Phase 1. Do not invent
  // a change in the independent position merely from a non-empty flag.
  return `${label}\n\n${summary ?? `Summary unavailable; complete answer follows.\n\n${answer}`}${flags.length ? `\n\n${flags.map(line => line.slice(2)).join('\n')}` : ''}${differed ? '\n\nA disagreement or scope mismatch is recorded; controller result for this operation and its parent shows the independent and reconciled answers in full.' : ''}${operation.result.warning ? `\n\nFabex warning: ${operation.result.warning}` : ''}`;
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
  return pending.filter(op => {
    // Only new-format cycles can collapse their independent reading. Legacy records
    // retain their full-answer obligation even when a newer child exists.
    if (op.request.phase === 'independent' && validSummary(op.result.structured?.ownerSummary)
      && pending.some(child => child.request.phase === 'reconcile' && child.request.parentOperationId === op.id && validSummary(child.result.structured?.ownerSummary))) return false;
    const required = validSummary(op.result.structured?.ownerSummary) ? op.result.structured.ownerSummary : op.result.finalResponse;
    return !visible.includes(normalizeRelay(required)) || !visible.includes(op.result.relay.label);
  });
}
