import { queueSelection } from './operation-queue.mjs';
import { createHash } from 'node:crypto';
import { changePrivate } from './private-store.mjs';

export function yieldStop() {
  // Internal flag: main removes it before emitting the host hook response.
  return { yielded: true, systemMessage: 'Fabex has paused automatic continuation because a pending check has not progressed. Your unfinished work and unread replies remain saved; neither has been marked complete.' };
}

export function activePartnerStop(state) {
  let operation = state?.operations?.find(op => op.status === 'working');
  if (!operation) {
    const selection = queueSelection(state?.operations ?? [], state?.workspace?.seals);
    if (selection.review) return null; // recovery reminder handles this gap once
    operation = selection.operation ?? state?.operations?.find(op => op.status === 'queued');
  }
  return operation ? { decision: 'block', reason: `Partner operation ${operation.id} is ${operation.status}. Run controller.mjs wait --operation-id ${operation.id} --timeout 60, then read its result. Keep waiting after a timeout; do not resubmit or repeat unchanged status replies.` } : null;
}

export function stopFingerprint(input, decision, state) {
  const operations = state?.operations ?? [];
  const mentioned = operations.filter(op => decision.reason?.includes(op.id));
  const cycles = new Set(mentioned.map(op => op.request.parentOperationId
    ?? (op.request.phase === 'independent' ? op.id : null)).filter(Boolean));
  // A continuation adds a sibling review to the same owner cycle. Even when
  // the reminder still names the preceding review, that is real progress.
  const relevant = operations.filter(op => mentioned.includes(op) || cycles.has(op.id)
    || cycles.has(op.request.parentOperationId)).map(op => ({
    id: op.id, status: op.status, cancelled: op.lifecycle?.cancelRequested,
    proposedDisposition: op.request.workDisposition,
    disposition: op.result?.structured?.workDisposition, warning: op.result?.warning,
    relay: op.result?.relay?.status
  }));
  // Generation, timestamps, usage, tool events and unrelated operations are not
  // progress on the condition that blocked Stop.
  return createHash('sha256').update(JSON.stringify({
    session: input.session_id, owner: state?.contextEvidence?.ownerPrompt?.digest,
    route: state?.route, milestone: state?.workspace?.activeMilestoneId,
    reason: decision.reason, relevant
  })).digest('hex');
}

export function repeatStopDecision(input, decision, state, previous) {
  const active = activePartnerStop(state);
  if (active && decision.decision !== 'block') decision = active;
  if (decision.decision !== 'block') return { decision, fingerprint: null };
  const fingerprint = stopFingerprint(input, decision, state);
  return { fingerprint, decision: !active && input.stop_hook_active === true && previous === fingerprint
    ? yieldStop(`The same check is still unresolved. ${decision.reason}`) : decision };
}

export async function guardStopProgress(root, input, decision, state, env = process.env) {
  const active = activePartnerStop(state);
  if (active && decision.decision !== 'block') decision = active;
  if (typeof input.session_id !== 'string' || !input.session_id) return !active && input.stop_hook_active === true && decision.decision === 'block'
    ? yieldStop(decision.reason) : decision;
  try {
    return await changePrivate(root, 'stop-progress.json', { sessions: [] }, data => {
      if (!Array.isArray(data.sessions)) throw new Error('invalid Stop progress record');
      const previous = data.sessions.find(item => item.sessionId === input.session_id)?.fingerprint;
      const result = repeatStopDecision(input, decision, state, previous);
      data.sessions = data.sessions.filter(item => item.sessionId !== input.session_id).slice(-127);
      // Retain a yielded block fingerprint: additional Stop calls do not restart
      // the same loop. A new owner prompt or real outcome changes the digest.
      if (result.fingerprint) data.sessions.push({ sessionId: input.session_id, fingerprint: result.fingerprint });
      return result.decision;
    }, env);
  } catch {
    // A broken diagnostic sidecar must not create an unbounded recovery loop.
    return !active && input.stop_hook_active === true ? yieldStop(decision.reason ?? decision.systemMessage ?? 'Stop progress could not be recorded; inspect Fabex diagnostics.') : decision;
  }
}
