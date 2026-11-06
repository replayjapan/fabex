import { createHash } from 'node:crypto';
import { changePrivate } from './private-store.mjs';

// Reminder receipts are distinct from delivery receipts. No change to the
// operation schema, no inferred completion, no acknowledgement of unseen text.
export async function stopNoticesOnce(root, sessionId, notices, env = process.env) {
  if (!notices.length || !sessionId) return null;
  try {
    return await changePrivate(root, 'delivery-feedback.json', { sessions: {} }, data => {
      const seen = new Set(data.sessions[sessionId] ?? []);
      const messages = [];
      for (const notice of notices) {
        const key = createHash('sha256').update(notice.key).digest('hex');
        if (!seen.has(key)) { messages.push(notice.message); seen.add(key); }
      }
      data.sessions[sessionId] = [...seen];
      return [...new Set(messages)].join('\n') || null;
    }, env);
  } catch {
    // Diagnostic storage failure must not generate a repeated Stop loop.
    return null;
  }
}

// A recovery prompt is offered once for an unchanged set, independently of
// stop_hook_active and unrelated state writes. It never acknowledges delivery.
export async function applyStopReminder(root, sessionId, decision, env = process.env) {
  const { reminder, ...result } = decision;
  if (!reminder || !sessionId) return result;
  const first = await stopNoticesOnce(root, sessionId,
    [{ key: `recovery:${reminder.key}`, message: 'first' }], env);
  if (!first) return result;
  return { ...result, decision: 'block', reason: reminder.reason };
}
