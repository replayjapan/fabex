import { blockingReviewWarning } from './review-warnings.mjs';
import { dispositionConflictOnly, supersedingDisposition } from './work-disposition.mjs';
import { activitySnapshot } from './activity.mjs';
import { resolveSettings } from './workspace-settings.mjs';
import { loadEffectiveConfig } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { changePrivate, readPrivate, sidecar } from './private-store.mjs';
import { textDigest, notificationLikePrompt, ownerFabexCommand } from './hook-evidence.mjs';
import { attachmentShape, selectedModeAttachments } from './attachments.mjs';

const NAME = 'owner-delivery.json';
const LIMIT = 16 * 1024 * 1024;
const empty = () => ({ schemaVersion: 1, entries: [] });
export { blockingReviewWarning };
function validate(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.some(e =>
    !/^[a-f0-9-]{36}$/.test(e.id ?? '') || typeof e.sessionId !== 'string' || !e.sessionId ||
    typeof e.text !== 'string' || textDigest(e.text) !== e.digest || !Array.isArray(e.attachments) ||
    !['captured', 'submitted', 'assessed', 'reconciled', 'failed'].includes(e.status)
    || e.dispositionResolution && (!/^[a-f0-9-]{36}$/.test(e.dispositionResolution.conflictId ?? '')
      || !/^[a-f0-9-]{36}$/.test(e.dispositionResolution.reviewId ?? '')
      || !/^[a-f0-9]{64}$/.test(e.dispositionResolution.ownerDigest ?? '')))) throw new Error('Owner delivery journal is invalid; preserve it and diagnose.');
  return data;
}
export async function ownerDeliveries(root, env = process.env) {
  return validate(await readPrivate(await sidecar(root, NAME, env), empty(), LIMIT)).entries;
}
export function ownerDeliveryReplay(entry, input) {
  const hostId = typeof input.message_id === 'string' ? input.message_id : typeof input.prompt_id === 'string' ? input.prompt_id : null;
  return Boolean(hostId && entry.sessionId === input.session_id && entry.hostId === hostId
    && entry.text === input.prompt
    && JSON.stringify(entry.rawAttachments) === JSON.stringify(input.attachments ?? input.images ?? []));
}
export async function captureOwnerDelivery(root, input, state, env = process.env) {
  const participants = resolveSettings((await loadEffectiveConfig(root, env)).config, state, input.session_id).values.participants;
  const activity = await activitySnapshot(root, input.session_id, env);
  const route = state.route === 'recovery-read-only' ? state.route : activity.activity === 'work' ? 'normal' : activity.activity === 'ask' ? 'ask-once' : 'discussion';
  if (typeof input?.prompt !== 'string' || notificationLikePrompt(input.prompt) || ownerFabexCommand(input.prompt) || participants === 'claude') return null;
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 256) throw new Error('Owner delivery requires the originating session.');
  if (Buffer.byteLength(input.prompt) > 192 * 1024) throw new Error('Owner message exceeds delivery capacity; no partial message was accepted.');
  // Some hosts reuse an event ID for distinct mid-turn messages. Only an exact
  // session/ID/content replay is a retry. Without an ID, each invocation is new.
  const hostId = typeof input.message_id === 'string' ? input.message_id : typeof input.prompt_id === 'string' ? input.prompt_id : null;
  let attachments = [], attachmentError = null;
  const rawAttachments = input.attachments ?? input.images ?? [];
  try { attachments = attachmentShape([...new Set([...selectedModeAttachments(input.prompt), ...attachmentShape(rawAttachments)])]); }
  catch (error) { attachmentError = error.message; }
  if (!attachments.length && (/\[Image(?:\s|#|\])|<image\b/i.test(input.prompt) || input.content?.some?.(part => part?.type === 'image'))) attachmentError = 'The host indicated an image without a usable selected path; preserve the attachment and resolve its reference before submission.';
  return changePrivate(root, NAME, empty(), data => {
    validate(data);
    const prior = data.entries.find(e => ownerDeliveryReplay(e, input));
    if (prior) return { ...prior, duplicate: true };
    const reply = state.recordedReply?.sessionId === input.session_id && state.recordedReply.status === 'available' && state.contextEvidence.ownerVisibleReply?.digest === textDigest(state.recordedReply.text) ? state.recordedReply.text : null;
    const entry = { id: randomUUID(), hostId, sessionId: input.session_id, text: input.prompt, digest: textDigest(input.prompt),
      route, participants, capturedAt: new Date().toISOString(), attachments, rawAttachments,
      previousReply: reply, status: 'captured', error: attachmentError, attachmentError, reconciliationId: null };
    data.entries.push(entry);
    return entry;
  }, env, LIMIT);
}
export async function updateOwnerDelivery(root, id, fields, env = process.env) {
  return changePrivate(root, NAME, empty(), data => {
    validate(data);
    const entry = data.entries.find(e => e.id === id);
    if (!entry) throw new Error('Owner delivery record is missing.');
    Object.assign(entry, fields);
    validate(data);
    return entry;
  }, env, LIMIT);
}

function resolvedConflict(entry, child) {
  // Keep the receipt after a later question, session switch or operation pruning.
  // It resolves this exact conflict, never a subsequently failed child.
  return entry.status === 'reconciled' && entry.dispositionResolution?.conflictId === child?.id
    && dispositionConflictOnly(child);
}

export function deliveryNextAction(state, entry) {
  const parent = state.operations.find(op => op.id === entry.id);
  const child = state.operations.findLast(op => op.request.parentOperationId === entry.id);
  const target = child ?? parent;
  if (!target) return `Delivery ${entry.id} has no retained operation. Run control.mjs recover abandon --operation-id ${entry.id}, then report the interrupted delivery; preserve unfinished work.`;
  if (['queued', 'working'].includes(target.status)) return `Operation ${target.id} is ${target.status}. Run controller.mjs wait --operation-id ${target.id} --timeout 60, then controller.mjs result --operation-id ${target.id}. Keep waiting after a timeout; do not resubmit.`;
  if (dispositionConflictOnly(target)) {
    const latestParent = state.operations.findLast(op => op.request.phase === 'independent' && !op.request.interrupted && op.result?.relay?.sessionId === entry.sessionId);
    const latest = state.operations.findLast(op => op.request.parentOperationId === latestParent?.id);
    const review = latest?.status === 'completed' ? latest : target;
    if (review.id !== target.id) return `Operation ${target.id} has unresolved bookkeeping that the newer review ${review.id} did not settle. Read controller.mjs result --operation-id ${target.id}; use control.mjs recover abandon --operation-id ${target.id} and report the interrupted cycle while preserving unfinished work. Then inspect controller.mjs result --operation-id ${review.id} before continuing the current task.`;
    return `Operation ${target.id} has unresolved work bookkeeping. Read controller.mjs result --operation-id ${target.id}; reconcile the complete current task with controller.mjs continue --operation-id ${review.id} --disposition '<JSON disposition>'. Do not mark unfinished work done.`;
  }
  return `Read controller.mjs result --operation-id ${target.id}; ${child ? 'resolve the reported review failure, or use control.mjs recover abandon --operation-id ' + target.id + ' and report the interruption' : 'submit its matching Phase 2 review'}. Preserve unfinished work.`;
}

export function deliveryObligations(entries, state, sessionId) {
  return entries.filter(e => e.sessionId === sessionId).map(e => {
    const parent = state.operations.find(op => op.id === e.id);
    const child = state.operations.findLast(op => op.request.parentOperationId === e.id);
    if (resolvedConflict(e, child) || supersedingDisposition(state, child)) return null;
    // Legacy journals could lose the failure text when their operation was
    // pruned. A failure already reported to the owner must not become captured
    // work again merely because the operation is no longer retained.
    if (!parent && !child && e.failureReportedAt) return null;
    if (e.status === 'reconciled' && !child || child?.status === 'completed' && !blockingReviewWarning(child) || parent?.request.phase === 'single' && parent.status === 'completed' && !blockingReviewWarning(parent)) return null;
    const failed = [child, parent].find(op => op && (['failed', 'cancelled'].includes(op.status) || op.status === 'completed' && blockingReviewWarning(op)));
    const failure = e.error || (failed ? failed.result.error || failed.result.warning || failed.lifecycle.detail : null)
      || (parent?.request.interrupted ? 'Owner cycle was interrupted or abandoned; task remains unfinished.' : null);
    if (failure && e.failureReportedAt) return null; // retained failure, visibly handed back; never a completed task
    return { id: e.id, status: failure ? 'failed' : parent?.status === 'completed' ? 'assessed' : parent ? 'submitted' : 'captured', error: failure, failureReportedAt: e.failureReportedAt ?? null, nextAction: deliveryNextAction(state, e) };
  }).filter(Boolean);
}
export async function syncOwnerDeliveries(root, state, env = process.env) {
  const entries = await ownerDeliveries(root, env);
  for (const entry of entries) {
    const parent = state.operations.find(op => op.id === entry.id);
    if (!parent) continue;
    const latestChild = state.operations.findLast(op => op.request.parentOperationId === entry.id);
    if (resolvedConflict(entry, latestChild)) continue;
    const resolution = supersedingDisposition(state, latestChild);
    if (resolution) {
      await updateOwnerDelivery(root, entry.id, { status: 'reconciled', reconciliationId: resolution.id, error: null, failureReportedAt: null,
        dispositionResolution: { conflictId: latestChild.id, reviewId: resolution.id, ownerDigest: resolution.request.ownerMessageDigest } }, env);
      continue;
    }
    const child = latestChild?.status === 'completed' && !blockingReviewWarning(latestChild) ? latestChild : null;
    const failedChild = latestChild && (['failed', 'cancelled'].includes(latestChild.status) || latestChild.status === 'completed' && blockingReviewWarning(latestChild));
    const status = child || parent.request.phase === 'single' && parent.status === 'completed' && !blockingReviewWarning(parent) ? 'reconciled'
      : failedChild || ['failed', 'cancelled'].includes(parent.status) || parent.request.interrupted || entry.status === 'failed' && entry.error ? 'failed' : parent.status === 'completed' ? 'assessed' : 'submitted';
    const error = status === 'failed' ? (failedChild ? latestChild.result.error || blockingReviewWarning(latestChild) || latestChild.lifecycle.detail : entry.error || parent.result.error || (parent.request.interrupted ? 'Owner cycle interrupted or abandoned; task remains unfinished.' : parent.lifecycle.detail)) : null;
    if (entry.status !== status || entry.error !== error) await updateOwnerDelivery(root, entry.id, { status, reconciliationId: child?.id ?? null, error }, env);
  }
}

export async function abandonMissingDelivery(root, state, id, env = process.env) {
  if (state.operations.some(op => op.id === id || op.request.parentOperationId === id)) return false;
  const entry = (await ownerDeliveries(root, env)).find(item => item.id === id && item.sessionId === state.workspace.activeSessionId
    && ['captured', 'submitted', 'assessed', 'failed'].includes(item.status));
  if (!entry) return false;
  await updateOwnerDelivery(root, id, { status: 'failed', error: 'Owner delivery has no retained operation and was abandoned during recovery; task remains unfinished.', failureReportedAt: null }, env);
  return true;
}

export async function recordResearchHelper(root, input, env = process.env) {
  if (typeof input.session_id !== 'string' || !input.session_id || typeof input.agent_id !== 'string' || !input.agent_id || input.agent_id.length > 256) return;
  return changePrivate(root, 'research-helpers.json', { helpers: [] }, data => {
    const prior = data.helpers.find(e => e.id === input.agent_id && e.sessionId === input.session_id);
    if (input.hook_event_name === 'SubagentStart' && !prior) data.helpers.push({ id: input.agent_id, sessionId: input.session_id, status: 'working' });
    if (input.hook_event_name === 'SubagentStop' && prior) prior.status = 'completed';
  }, env);
}
export async function ownsResearchHelper(root, sessionId, id, env = process.env) {
  if (!sessionId || !id) return false;
  const data = await readPrivate(await sidecar(root, 'research-helpers.json', env), { helpers: [] });
  return data.helpers.some(e => e.id === id && e.sessionId === sessionId);
}
