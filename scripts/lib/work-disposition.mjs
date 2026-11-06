import { blockingReviewWarning } from './review-warnings.mjs';
import { rejectPayloadLikeText } from './checkpoint.mjs';
import { createHash } from 'node:crypto';

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

// Only bookkeeping conflicts can be superseded. A blocker, owner decision,
// failed review or mixed diagnostic requires its own explicit recovery.
export function dispositionConflictOnly(operation) {
  const warning = blockingReviewWarning(operation);
  const values = [operation?.request?.workDisposition, operation?.result?.structured?.workDisposition];
  return operation?.status === 'completed' && operation.request.phase === 'reconcile'
    && operation.request.route === 'normal' && !operation.lifecycle?.cancelRequested
    && !operation.result.error && Boolean(warning)
    && warning.split('\n').every(line => line.startsWith(DISPOSITION_WARNING))
    && Boolean(dispositionProblem(...values))
    && !values.some(value => ['blocked', 'owner-decision'].includes(value?.status));
}

export function supersedingDisposition(state, conflict) {
  if (!dispositionConflictOnly(conflict)) return null;
  const session = conflict.result.relay?.sessionId;
  const origin = state.operations.findIndex(op => op.id === conflict.request.parentOperationId);
  const original = state.operations[origin];
  if (origin < 0 || original.status !== 'completed' || original.request.interrupted || original.lifecycle?.cancelRequested
    || blockingReviewWarning(original) || original.result?.relay?.sessionId !== session) return null;
  const parent = state.operations.findLast(op => op.request.phase === 'independent'
    && op.result?.relay?.sessionId === session && !op.request.interrupted);
  if (!parent || state.operations.indexOf(parent) <= origin || parent.status !== 'completed' || parent.lifecycle?.cancelRequested
    || blockingReviewWarning(parent)) return null;
  const next = state.operations.findLast(op => op.request.parentOperationId === parent.id);
  if (!next || next.status !== 'completed' || next.request.phase !== 'reconcile' || next.request.route !== 'normal'
    || next.lifecycle.cancelRequested || next.result.error || blockingReviewWarning(next)
    || next.result.relay?.sessionId !== session || !reviewSessionMatches(state, next)
    || !next.externalId || next.externalId !== conflict.externalId || next.externalId !== state.partner.thread.threadId
    || state.route !== 'normal' || state.ownerSelectedMode?.route !== 'normal' || state.modeGrant
    || state.contextEvidence?.ownerPrompt?.digest !== next.request.ownerMessageDigest
    || parent.request.ownerMessageDigest !== next.request.ownerMessageDigest
    || !validDisposition(next.request.workDisposition) || !validDisposition(next.result.structured?.workDisposition)
    || dispositionProblem(next.request.workDisposition, next.result.structured.workDisposition)) return null;
  return next;
}

// Stop and the controller must agree on whether the command they offer can run.
// A repair enters review, not execution. Age alone never clears an owner action.
export const continuationSubmissionDigest = reviewId => createHash('sha256').update(`continue:${reviewId}`, 'utf8').digest('hex');

export function continuationEligibility(state, source, obligations = [], { repair = false, handoff = null } = {}) {
  const denied = reason => ({ ok: false, reason });
  if (!source || source.status !== 'completed' || source.request.phase !== 'reconcile') return denied('Continuation requires this session’s completed reconciliation; inspect its retained result.');
  const warning = blockingReviewWarning(source);
  const handoffPending = handoff && ['prepared', 'awaiting-receipt'].includes(handoff.status);
  if (warning && !(repair && warning.split('\n').every(line => line.startsWith(DISPOSITION_WARNING)))
    && !(handoffPending && warning === 'Fresh conversation has not acknowledged the reviewed handoff; implementation remains blocked.')) return denied(`Review ${source.id} is blocked: ${warning}. Inspect controller.mjs result --operation-id ${source.id} and resolve that condition.`);
  const parent = state.operations.find(op => op.id === source.request.parentOperationId);
  if (!parent || parent.status !== 'completed') return denied('The reconciliation has no completed retained independent parent; inspect the cycle before continuing.');
  if (parent.request.interrupted || parent.lifecycle?.cancelRequested || source.lifecycle.cancelRequested) return denied('This cycle was cancelled or abandoned; do not resume it. Review any new owner instruction in its own cycle.');
  if (!reviewSessionMatches(state, source)) return denied('This review belongs to a different session; resume its originating conversation.');
  if (source.externalId !== state.partner.thread.threadId && !(handoffPending && source.externalId === handoff.predecessor)) return denied('This review belongs to a different Codex thread; use the current thread’s reconciliation or complete the verified handoff.');
  const newerOwner = state.operations.slice(state.operations.indexOf(parent) + 1).some(op => op.request.phase === 'independent' && !op.request.interrupted);
  if (newerOwner || state.contextEvidence.ownerPrompt && state.contextEvidence.ownerPrompt.digest !== source.request.ownerMessageDigest) return denied('A newer owner message must be reconciled first; continue from its result, not this older review.');
  if (state.route !== 'normal' || state.ownerSelectedMode?.route !== 'normal' || state.modeGrant) return denied(continuationFailure(state, obligations));
  // Retrying the same accepted submission returns its ID, not another turn.
  // Source/session/cancellation/freshness checks above still apply.
  const accepted = state.operations.find(op => op.request.submissionDigest === continuationSubmissionDigest(source.id));
  if (accepted) return { ok: true, existingOperationId: accepted.id };
  const pending = repair ? obligations.filter(item => item.id !== parent.id) : obligations;
  const failure = continuationFailure(state, pending);
  if (!repair || !failure) return failure ? denied(failure) : { ok: true };
  if (state.route !== 'normal' || state.ownerSelectedMode?.route !== 'normal' || state.modeGrant || partnerNextAction(state) || pending.length) return denied(failure);
  const cp = state.partner.thread.checkpoint;
  if (cp.blocker) return denied(failure);
  if (cp.ownerActionRequired) {
    const recorded = cp.fieldUpdatedAt?.ownerActionRequired;
    const beforeCycle = Number.isFinite(Date.parse(recorded)) && Date.parse(recorded) < Date.parse(parent.lifecycle.queuedAt);
    if (!beforeCycle || !dispositionConflictOnly(source)) return denied(`Owner decision required: ${cp.ownerActionRequired}`);
    return { ok: true, requirementReview: { sourceReviewId: source.id, requirement: cp.ownerActionRequired, recordedAt: recorded } };
  }
  return { ok: true };
}

export function dispositionRepairEligibility(state, source, obligations = []) {
  return continuationEligibility(state, source, obligations, { repair: true });
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
  const requirement = operation.request.requirementReview;
  if (requirement && (cp.ownerActionRequired !== requirement.requirement || cp.fieldUpdatedAt.ownerActionRequired !== requirement.recordedAt
    || cp.blocker || !validDisposition(disposition)
    || ['done', 'remaining'].includes(disposition.status) && !operation.result.structured.evidence?.some(item => item.trim()))) {
    return `${DISPOSITION_WARNING} the owner requirement changed or its satisfaction lacks review evidence; preserve it and review the current requirement.`;
  }
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
  if (obligations.length) return `Owner review is pending for ${obligations.map(item => item.id).join(', ')}. ${obligations.map(item => item.nextAction ?? 'Finish the existing delivery before continuing.').join(' ')}`;
  if (cp.blocker) return `Work is blocked: ${cp.blocker}. Resolve or update that blocker before continuing.`;
  if (cp.ownerActionRequired) return `Owner decision required: ${cp.ownerActionRequired}`;
  if (!cp.continuation.armed) return 'Work has not been revalidated against the latest owner instructions. Reconcile its explicit disposition; do not ask for another go.';
  if (!cp.openWork.length) return 'The unfinished-work list is empty. Record an explicit completion or reconcile remaining work; an empty list alone is not completion.';
  return null;
}
