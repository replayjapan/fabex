// Queue selection is shared by the runner and Stop. A turn waiting for an
// earlier Phase 2 is retained, but is not runnable partner work.
export function queueSelection(operations, seals = {}) {
  for (const independent of operations.filter((operation) => operation.request?.phase === 'independent' && operation.status === 'completed' && !operation.request.interrupted)) {
    const reconciliation = operations.find((candidate) => candidate.request?.parentOperationId === independent.id);
    if (!reconciliation) {
      // An older unfinished review remains recorded, but must not prevent a
      // newly received, independently sealed instruction from reaching either
      // partner. Already queued cycles keep their Phase 1/Phase 2 FIFO order.
      const newer = operations.slice(operations.indexOf(independent) + 1).some(op =>
        ['queued', 'working', 'completed'].includes(op.status) && op.request?.phase === 'independent' && !op.request.interrupted
        && seals[op.id]?.reading
        && Date.parse(op.lifecycle?.queuedAt) > Date.parse(independent.lifecycle?.finishedAt));
      if (newer) continue;
      return { operation: null, review: independent };
    }
    if (reconciliation.status === 'queued') return { operation: reconciliation, review: null };
    if (reconciliation.status === 'working') return { operation: null, review: null };
  }
  const next = operations.find((operation) => operation.status === 'queued') ?? null;
  return { operation: next && seals[next.id] && !seals[next.id].reading ? null : next, review: null };
}

export function nextClaimableOperation(operations, seals = {}) {
  return queueSelection(operations, seals).operation;
}
