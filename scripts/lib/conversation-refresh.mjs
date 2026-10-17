import { createHash } from 'node:crypto';
import { readState } from './state.mjs';
import { changePrivate, readPrivate, sidecar } from './private-store.mjs';

const NAME = 'conversation-refresh.json';
const empty = () => ({ schemaVersion: 1, pending: null });
export const handoffDigest = text => createHash('sha256').update(text).digest('hex');
export async function refreshState(root, env = process.env) {
  const value = await readPrivate(await sidecar(root, NAME, env), empty());
  if (value?.schemaVersion !== 1 || value.pending && (!['needs-review', 'prepared', 'awaiting-receipt', 'verified'].includes(value.pending.status) || typeof value.pending.predecessor !== 'string')) throw new Error('Conversation refresh record is invalid.');
  if (value.pending?.conversationId) {
    const current = await readState(root, env);
    if (!current.ok) throw new Error(`Conversation refresh unavailable: ${current.health}`);
    if (current.state.workspace.activeConversationId !== value.pending.conversationId) return null;
  }
  // Threshold-generated requests are obsolete; do not revive them after reload.
  return value.pending?.status === 'needs-review' ? null : value.pending;
}
async function save(root, pending, env) {
  return changePrivate(root, NAME, empty(), value => { value.pending = pending; return pending; }, env);
}
// Compatibility entry points never select a new conversation from context usage.
export function refreshDue() { return false; }
export async function refreshAtSafePoint() { return { due: false }; }
export async function prepareOwnerRotation(root, predecessor, handoff, reviewId, env = process.env, conversationId = null) {
  return save(root, { status: 'prepared', origin: 'owner', predecessor, handoff,
    digest: handoffDigest(handoff), reviewId, conversationId }, env);
}
export async function clearRotationReceipt(root, env = process.env) { return save(root, null, env); }
export async function acknowledgeHandoff(root, threadId, review, env = process.env) {
  const pending = await refreshState(root, env);
  if (!pending || !['prepared', 'awaiting-receipt'].includes(pending.status)) return true;
  const current = await readState(root, env);
  if (!current.ok || current.state.partner.thread.threadId !== threadId || !threadId || threadId === pending.predecessor || !review?.evidence?.includes(`Handoff received: sha256:${pending.digest}`)) return false;
  await save(root, { ...pending, status: 'verified', receivedBy: threadId, receivedAt: new Date().toISOString() }, env);
  return true;
}
