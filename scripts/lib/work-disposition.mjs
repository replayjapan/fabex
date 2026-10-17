import { blockingReviewWarning } from './review-warnings.mjs';
import { rejectPayloadLikeText } from './checkpoint.mjs';

export const dispositionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['remaining', 'done', 'blocked', 'owner-decision'] },
    remainingWork: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    reason: { type: 'string' }
  }, required: ['status', 'remainingWork', 'reason']
};
export function validDisposition(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'reason,remainingWork,status'
    || !dispositionSchema.properties.status.enum.includes(value.status)
    || typeof value.reason !== 'string' || !value.reason.trim() || Buffer.byteLength(value.reason) > 1024
    || !Array.isArray(value.remainingWork) || value.remainingWork.length > 16
    || value.remainingWork.some(item => typeof item !== 'string' || !item.trim() || Buffer.byteLength(item) > 1024)
    || value.status === 'remaining' && !value.remainingWork.length
    || value.status === 'done' && value.remainingWork.length) return false;
  try { [value.reason, ...value.remainingWork].forEach(rejectPayloadLikeText); } catch { return false; }
  return true;
}

export const DISPOSITION_WARNING = 'Work disposition requires reconciliation:';
export function dispositionProblem(claude, codex) {
  // Explicit null from both partners means a question-only, scope-preserving turn.
  // Undefined (omitted) is missing bookkeeping, never an exemption.
  if (claude === null && codex === null) return null;
  if (!validDisposition(claude)) return `${DISPOSITION_WARNING} Claude must supply an explicit disposition; missing bookkeeping is not completion.`;
  if (!validDisposition(codex)) return `${DISPOSITION_WARNING} Codex must supply an explicit disposition; missing bookkeeping is not completion.`;
  if (claude.status !== codex.status) return `${DISPOSITION_WARNING} partners reported different outcomes (${claude.status}, ${codex.status}); settle the outcome before resuming.`;
  return null;
}

export function reviewSessionMatches(state, operation) {
  const sessionId = operation?.result?.relay?.sessionId;
  if (!sessionId) return false;
  if (state.workspace?.activeSessionId) return state.workspace.activeSessionId === sessionId;
  // Mode-grant cycles predating workspace registration retain their canonical
  // thread. Accept their captured session only while the registry is empty, and
  // only with matching owner evidence and the independently recorded parent.
  // Never use this fallback to take over another registered or active session.
  if (state.workspace?.activeSessionId !== null || Object.keys(state.workspace.sessions ?? {}).length) return false;
  const owner = state.contextEvidence?.ownerPrompt;
  const parent = state.operations.find(op => op.id === operation.request.parentOperationId);
  return owner?.sessionId === sessionId && owner.digest === operation.request.ownerMessageDigest
    && parent?.request.phase === 'independent' && parent.status === 'completed'
    && !parent.request.interrupted && parent.result?.relay?.sessionId === sessionId
    && parent.request.ownerMessageDigest === operation.request.ownerMessageDigest;
}

// Called inside the controller's state transaction. Older results cannot replace
// the checkpoint or rearm work after a newer instruction/session/mode arrived.
export function persistWorkDisposition(state, operation, now) {
  if (operation.request.phase !== 'reconcile' || operation.request.route !== 'normal') return null;
  const cp = state.partner.thread.checkpoint;
  const latest = state.contextEvidence?.ownerPrompt;
  const origin = operation.request.parentOperationId;
  const newer = state.operations.slice(state.operations.findIndex(op => op.id === origin) + 1)
    .some(op => op.request.phase === 'independent' && !op.request.interrupted);
  if (state.route !== 'normal' || state.ownerSelectedMode?.route !== 'normal' || state.modeGrant
    || operation.lifecycle.cancelRequested || newer
    || !reviewSessionMatches(state, operation)
    || latest && latest.digest !== operation.request.ownerMessageDigest
    || !state.operations.some(op => op.id === origin && !op.request.interrupted)) {
    cp.continuation.armed = false;
    return null;
  }
  const problem = dispositionProblem(operation.request.workDisposition, operation.result.structured?.workDisposition);
  cp.continuation.armed = false;
  if (problem) return problem;
  if (blockingReviewWarning(operation)) return null;
  const disposition = operation.result.structured.workDisposition;
  if (disposition === null) {
    // Preserve the task, completion/blocker fields and timestamps. The question
    // cannot create work or clear a decision; it only revalidates unchanged scope.
    cp.continuation.ownerDigest = operation.request.ownerMessageDigest;
    cp.continuation.armed = cp.openWork.length > 0 && !cp.blocker && !cp.ownerActionRequired;
    return null;
  }
  cp.openWork = [...disposition.remainingWork];
  cp.blocker = disposition.status === 'blocked' ? disposition.reason : null;
  cp.ownerActionRequired = disposition.status === 'owner-decision' ? disposition.reason : null;
  cp.nextAction = cp.openWork[0] ?? null;
  cp.continuation.ownerDigest = operation.request.ownerMessageDigest;
  cp.continuation.armed = disposition.status === 'remaining';
  for (const key of ['openWork', 'blocker', 'ownerActionRequired', 'nextAction']) cp.fieldUpdatedAt[key] = now;
  cp.updatedAt = now;
  return null;
}

export function partnerNextAction(state) {
  const working = state.operations.find(op => op.status === 'working');
  const independent = state.operations.find(op => op.request.phase === 'independent' && op.status === 'completed'
    && !op.request.interrupted && !state.operations.some(child => child.request.parentOperationId === op.id));
  if (!working && independent) return `Operation ${independent.id} awaits reconciliation. Read controller.mjs result --operation-id ${independent.id} and submit its matching Phase 2 with an explicit workDisposition.`;
  const active = working ?? state.operations.find(op => op.status === 'queued');
  return active ? `Partner operation ${active.id} is ${active.status}. Run controller.mjs wait --operation-id ${active.id} --timeout 60, then read its result. A timeout means keep waiting; do not resubmit or repeat unchanged status replies.` : null;
}

export function continuationFailure(state, obligations = []) {
  const cp = state.partner.thread.checkpoint;
  if (state.route !== 'normal' || state.ownerSelectedMode?.route !== 'normal') return 'Continuation is paused outside work mode; retain the task until the owner selects work mode.';
  if (state.modeGrant) return 'An owner activity transition is pending; finish that transition before continuing.';
  const partner = partnerNextAction(state);
  if (partner) return partner;
  if (obligations.length) return `Owner review is pending for ${obligations.map(item => item.id).join(', ')}; finish those existing deliveries before continuing.`;
  if (cp.blocker) return `Work is blocked: ${cp.blocker}. Resolve or update that blocker before continuing.`;
  if (cp.ownerActionRequired) return `Owner decision required: ${cp.ownerActionRequired}`;
  if (!cp.continuation.armed) return 'Work has not been revalidated against the latest owner instructions. Reconcile its explicit disposition; do not ask for another go.';
  if (!cp.openWork.length) return 'The unfinished-work list is empty. Record an explicit completion or reconcile remaining work; an empty list alone is not completion.';
  return null;
}
