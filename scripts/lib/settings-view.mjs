import { basename } from 'node:path';
import { TRACKER_INSTALL } from './tracker-discovery.mjs';
import { readUsageCache } from './usage-integration.mjs';
import { TASKS } from './settings-menu.mjs';

const source = name => ({ session: 'this conversation', milestone: 'this milestone', project: 'project default', machine: 'computer default', 'plugin/legacy-config': 'default' })[name] ?? 'configured default';
const value = v => v ?? 'default';
export function taskValue(status, role, field) {
  const keys = (role === 'testing' ? ['testWriting', 'testRunning'] : [role]).map(r => `roles.${r}.${field}`);
  const describe = key => status.values[key] === null ? `same as main ${field}` : `${field === 'executor' ? status.values[key][0].toUpperCase() + status.values[key].slice(1) : status.values[key]} (${source(status.sources[key])})`;
  return keys.length === 2 && status.values[keys[0]] !== status.values[keys[1]] ? `writing: ${describe(keys[0])}; running: ${describe(keys[1])}` : describe(keys[0]);
}
export async function settingsView(status, env = process.env) {
  const t = status.tracking, i = t.installation, v = status.values;
  const codex = v['partners.codex.model'] ?? status.models?.codex?.id ?? 'configured in Codex';
  const claude = status.models?.claude;
  const claudeSource = claude?.source === 'session hook evidence' ? 'reported by this conversation' : claude?.id ? 'configured default' : 'not reported';
  const lines = [`Project: ${basename(status.project)}`, status.milestone.id === 'legacy' ? 'Milestone: none chosen yet (earlier work is kept). Name the stage from your plan with /fabex:milestone.' : `Milestone: ${status.milestone.name}; use /fabex:milestone to select a different stage of your plan.`,
    '', 'Models', `Codex model: ${codex} (${source(status.sources['partners.codex.model'])}).`,
    `Codex reasoning effort: ${value(v['partners.codex.effort'])} (${source(status.sources['partners.codex.effort'])}); more reasoning can take longer.`,
    `Claude model: ${claude?.id ?? 'Unknown'} (${claudeSource}); change it with /model and use Claude’s own effort control.`,
    'The picker lists models and effort levels reported by Codex; if unavailable, it says so without guessing.'
  ];
  for (const field of ['model', 'effort']) if (v[`partners.claude.${field}`] !== null) lines.push(`Saved Claude ${field} note: ${v[`partners.claude.${field}`]}; this does not change the running chat.`);
  const observed = status.observations?.codex;
  if (observed?.observed && observed.requested && observed.observed !== observed.requested) lines.push(`Model differs: Codex requested ${observed.requested} but reported ${observed.observed} (${observed.at}).`);
  lines.push('', 'Who does what');
  for (const [label, role] of Object.entries(TASKS)) {
    if (role === 'testing') lines.push(`Testing: ${taskValue(status, 'testRunning', 'executor')} runs tests; test code is written by the Coding AI (${v['roles.implementation.executor'] === 'claude' ? 'Claude' : 'Codex'}); running model: ${taskValue(status, 'testRunning', 'model')}; effort: ${taskValue(status, 'testRunning', 'effort')}.`);
    else lines.push(`${label}: ${taskValue(status, role, 'executor')}; model: ${taskValue(status, role, 'model')}; effort: ${taskValue(status, role, 'effort')}.`);
  }
  lines.push('Documentation defaults to Both: Claude and Codex read and update the same handoff or document.', 'With Both, task model and effort choices apply to Codex only; Claude uses its own host controls.', 'Coding selects the only code editor, including test code; other partners review or run checks.', 'Documentation writers may share text documents, not code. Owner-authorized sub-agent exceptions remain available.', 'Both give independent answers using their main models; task model and effort choices apply when Codex does the work.', 'Fabex cannot change the model or effort of Claude’s running chat.',
    '', `Weekly usage: ${t.effective} (${source(t.source)}); reports account allowance and recorded usage.`,
    `Tracker: ${i.status === 'found' ? 'installed' : i.status}.`);
  if (i.status === 'ambiguous') {
    lines.push('', i.reason);
    for (const c of i.candidates) lines.push(`Select ${c.source}: /fabex:settings usageTracker.path=${JSON.stringify(c.path)} scope=session`);
  } else if (i.status !== 'found') lines.push('', i.reason, 'Install the separate plugin containing Weekly Tracker:', ...TRACKER_INSTALL, 'Restart Claude Code, then open /fabex:settings again.');
  else {
    const cache = await readUsageCache(status.project, i, status.milestone.id, env);
    if (!cache.allowances?.some(a => a.provider === 'claude')) lines.push('', 'No Claude allowance reading is available; ask for Weekly Tracker setup help if needed.');
  }
  lines.push('', 'Choose a value and where it applies together; a conversation setting takes priority over its milestone, then the project.', 'Default removes that override. Click tabs to revisit choices; Back and Cancel are buttons. Nothing is saved until Apply.', 'Prefer typing? Example: /fabex:settings tracking=on');
  return lines.join('\n') + '\n';
}
