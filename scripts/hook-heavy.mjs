#!/usr/bin/env node
import { recordWorkspaceSelection } from './lib/workspace.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFromHookInput } from './lib/paths.mjs';
import { heavyStatus, finishHeavy, backgroundHeavy } from './lib/heavy.mjs';
import { registerHostResource, completeHostResource } from './lib/resources.mjs';
import { verifiedGone } from './lib/process-evidence.mjs';

export async function recordToolCompletion(root, input, env = process.env, options = {}) {
  const id = input.tool_use_id ? `host:${input.session_id ?? ''}:${input.tool_use_id}` : null;
  const raw = input.tool_response;
  let response = raw;
  if (typeof raw === 'string') { try { response = JSON.parse(raw); } catch { response = {}; } }
  response ??= {};
  const task = response.background_task_id ?? response.task_id;
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Bash' && task) {
    if (id) await backgroundHeavy(root, id, task, env);
    await registerHostResource(root, { taskId: task, command: input.tool_input?.command }, env);
    return;
  }
  if (input.tool_name === 'Bash' && input.tool_input?.run_in_background && input.hook_event_name === 'PostToolUse') return; // no proven task identity; retain reservation
  const status = await heavyStatus(root, env);
  const completed = id && status.jobs.find(job => job.id === id);
  if (completed && (!completed.identity || await verifiedGone(completed.identity, options))) await finishHeavy(root, id, env, { ...options, evidence: input.hook_event_name ?? 'host-completed' });
  const completedTask = input.tool_input?.task_id;
  if (input.hook_event_name === 'PostToolUse' && completedTask &&
    !response.error && !response.is_error && response.success !== false &&
    (input.tool_name === 'TaskStop' && (response.success === true || response.status === 'stopped' || response.task?.status === 'stopped') || input.tool_name === 'TaskOutput' && ['completed', 'failed', 'stopped'].includes(response.status ?? response.task?.status))) {
    const job = status.jobs.find(job => job.hostTaskId === completedTask);
    if (job && (!job.identity || await verifiedGone(job.identity, options))) await finishHeavy(root, completedTask, env, { ...options, evidence: 'host-task-completed' });
    await completeHostResource(root, completedTask, env);
  }
}
export async function main() {
  try {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const root = await rootFromHookInput(input, process.env);
    if (input.tool_name === 'AskUserQuestion') {
      const selected = await recordWorkspaceSelection(root, input);
      process.stdout.write(JSON.stringify(selected ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Owner selection recorded: ${selected.selection}. Apply once with control.mjs settings apply --grant ${selected.grantId}, between completed review cycles.` } } : {}) + '\n');
      return;
    }
    await recordToolCompletion(root, input);
    process.stdout.write('{}\n');
  } catch { process.stdout.write(JSON.stringify({ systemMessage: 'Fabex could not acknowledge resource completion; inspect heavy status/resources before more heavy work.' }) + '\n'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
