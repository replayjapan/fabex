import { TRACKER_INSTALL } from './tracker-discovery.mjs';
import { readUsageCache } from './usage-integration.mjs';

export function settingsQuestions(args, project, milestone) {
  const modes = args ? [args.split('=')[1]] : ['on', 'off', 'inherit'];
  const questions = [{ question: 'Where should weekly usage tracking apply?', header: 'Scope', multiSelect: false, options: [
    { label: 'Project', description: `Default for all milestones in ${project}.` },
    { label: 'Current milestone', description: `Only ${milestone}; persists across chats and thread rollovers.` }
  ] }];
  if (!args) questions.push({ question: 'Choose weekly usage tracking.', header: 'Tracking', multiSelect: false, options: [
    { label: 'On', description: 'Record and report usage when the tracker is available.' },
    { label: 'Off', description: 'Disable Fabex usage calls and ordinary report sections.' },
    { label: 'Inherit', description: 'Remove this override and use the inherited setting.' }
  ] });
  return { questions, options: modes.flatMap(mode => ['project', 'milestone'].map(scope => `tracking=${mode} scope=${scope}`)) };
}

export async function settingsView(status, env = process.env) {
  const t = status.tracking, i = t.installation;
  const lines = [
    `Project: ${status.project}`, `Current milestone: ${status.milestone.name}`,
    '', `Weekly usage tracking: ${t.effective} (from ${t.source})`,
    `Installation: ${i.status}${i.path ? ` — ${i.path}` : ''}`,
    `Project default: ${t.project}; milestone: ${t.milestone}; this chat: ${t.session}`,
    'Choose where to turn on: /fabex:settings tracking=on',
    'Turn on for project: /fabex:settings tracking=on scope=project',
    'Turn on for current milestone: /fabex:settings tracking=on scope=milestone',
    'Turn off for project: /fabex:settings tracking=off scope=project',
    'Turn off for current milestone: /fabex:settings tracking=off scope=milestone',
    'Use project setting in this milestone: /fabex:settings tracking=inherit scope=milestone',
    'Clear this chat override: /fabex:settings tracking=inherit scope=session'
  ];
  if (i.status === 'ambiguous') {
    lines.push('', i.reason);
    for (const c of i.candidates) lines.push(`Select ${c.source}: /fabex:settings usageTracker.path=${JSON.stringify(c.path)} scope=session`);
  } else if (i.status !== 'found') lines.push('', i.reason, 'Install the independent plugin containing Weekly Tracker:', ...TRACKER_INSTALL, 'Restart Claude Code, then open /fabex:settings again.');
  else {
    const cache = await readUsageCache(status.project, i, status.milestone.id, env);
    if (!cache.allowances?.some(a => a.provider === 'claude')) lines.push('', 'No cached Claude allowance reading. This may mean missing setup or unsupported/missing source fields.', `Preview optional allowance setup: ${JSON.stringify(i.path)} setup-claude`, 'Apply the preview only on owner instruction with setup-claude --apply; then allow a new Claude reading and a usage snapshot.');
  }
  lines.push('', 'Other settings (commands below affect this chat; add scope=project for a project default):');
  for (const partner of ['claude', 'codex']) for (const option of ['model', 'effort']) {
    const key = `partners.${partner}.${option}`;
    lines.push(`${partner} ${option}: ${status.values[key] ?? 'host/default'} — /fabex:settings ${key}=<${option}> scope=session`);
  }
  lines.push('Model and effort commands save preferences; Claude host controls and provider availability still apply.');
  for (const [key, value] of Object.entries(status.values).filter(([key]) => /^roles\..*\.executor$/.test(key))) lines.push(`${key.split('.')[1]} executor: ${value} — /fabex:settings ${key}=${value === 'claude' ? 'codex' : 'claude'} scope=session`);
  const key = 'milestones.newChatMeansNewMilestone';
  lines.push(`New chat starts a new milestone: ${status.values[key]} — /fabex:settings ${key}=${!status.values[key]} scope=project`, 'Full settings and sources: /fabex:settings --json');
  return lines.join('\n') + '\n';
}
