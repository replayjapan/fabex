import { readState, updateState } from './state.mjs';

export async function consumeWaitBudget(root, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`Wait budget unavailable: ${current.health}`);
  let budget = { exhausted: false, used: 0, limit: 20 };
  const result = await updateState(root, state => {
    const counter = state.partner.thread.checkpoint.continuation;
    budget = { exhausted: counter.used >= counter.limit, used: counter.used, limit: counter.limit };
    if (!budget.exhausted) counter.used++;
    budget.used = counter.used;
    state.generation++;
    return state;
  }, { purpose: 'bounded-wait' }, env);
  if (!result.ok) throw new Error('Wait budget could not be recorded; inspect state instead of retrying blindly');
  return budget;
}
