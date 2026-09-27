import { isDeepStrictEqual } from 'node:util';

export const TASKS = { Coding: 'implementation', Testing: 'testing', 'Image review': 'imageReview', Documentation: 'docs' };
const scopes = { 'Only this conversation': 'session', 'This planned milestone': 'milestone', 'Default for this project': 'project' };
const controls = { 'Who does it': 'executor', Model: 'model', 'Reasoning effort': 'effort' };
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const targets = ['tracking', 'partners.codex.model', 'partners.codex.effort', ...Object.values(TASKS).flatMap(role => Object.values(controls).map(field => `roles.${role}.${field}`))];
const option = (label, description) => ({ label, description });
function question(text, options, header = 'Settings') {
  if (options.length < 4 && !options.some(o => o.label === 'Cancel')) options.push(option('Cancel', 'Close settings without saving.'));
  return [{ question: `${text} Use Other to type Back or Cancel.`, header, multiSelect: false, options }];
}
export function startSettingsMenu(args, context) {
  const flow = { stage: args ? 'scope' : 'section', target: args ? 'tracking' : null, scope: null, value: args ? args.split('=')[1] : null, history: [], context };
  return { flow, questions: menuQuestions(flow), selection: null, questionToolId: null };
}
function scopeQuestion(f) {
  return question('Where should this change apply? Submitting the choices saves one change for the next applicable turn.', Object.entries(scopes).map(([label, scope]) => option(label, scope === 'project' ? f.context.project : scope === 'milestone' ? f.context.milestone : 'Only this conversation; it overrides the milestone or project.')), 'Scope');
}
function valueQuestion(f) {
  const reset = option('Use default', 'Remove this override: a conversation uses its milestone/project, a milestone uses its project, and a project uses the normal default.');
  if (f.target === 'tracking') return question('Weekly usage reports', [option('On', 'Record and report usage when the tracker is available.'), option('Off', 'No Fabex tracking calls or ordinary usage reminders.'), reset], 'Value');
  if (f.target.endsWith('.executor')) return question('Who should do this task?', [option('Claude', 'Claude does the task; Codex retains independent review.'), option('Codex', 'Codex does the task; Claude retains independent review.'), reset], 'Value');
  if (f.target.endsWith('.model')) {
    const suggestions = f.context.models.slice(0, 2).map(id => option(id, 'Configured or previously observed suggestion; availability is checked on use.'));
    return question('Choose a model, or type its name in Other; unavailable models are reported without substitution.', [option('Use normal model', f.target.startsWith('roles.') ? 'Use the main model for this AI.' : 'Use the model configured in Codex.'), ...suggestions, reset], 'Value');
  }
  return question('Choose how much reasoning to request; Other also accepts minimal, xhigh, max, ultra or persistent, subject to model support.', [option('low', 'Request less reasoning.'), option('medium', 'Request medium reasoning.'), option('high', 'Request more reasoning.'), reset], 'Value');
}
export function menuQuestions(f) {
  const c = f.context;
  switch (f.stage) {
    case 'section': return question('What would you like to view or change?', [option('Models', 'Choose the main Codex model and effort; see Claude controls.'), option('Who does what', 'Coding, Testing, Image review, or Documentation.'), option('Weekly usage', 'Turn optional usage reports on or off.')]);
    case 'models': return question('Choose a model control.', [option('Codex model', 'Which Codex AI gives its independent answer and does work without a task override.'), option('Codex reasoning effort', 'How much reasoning to request; more may take longer.'), option('Claude model and effort', 'View the model; change the running chat through Claude’s own controls.')]);
    case 'claude': return question(`Claude: ${c.claude}; use /model and Claude’s effort control because Fabex cannot switch the running chat.`, [option('Back', 'Return to Models.'), option('Cancel', 'Close settings without saving.')]);
    case 'task': return question('Choose the task.', Object.entries(TASKS).map(([label]) => option(label, ({ Coding: 'Write or change code.', Testing: 'Write automated tests and run them.', 'Image review': 'Inspect images and screenshots.', Documentation: 'Write documentation.' })[label])));
    case 'control': return question(`${c.taskLabel ?? ''}: choose what to change. ${c.taskNote ?? ''}`, Object.keys(controls).map(label => option(label, label === 'Who does it' ? 'Choose Claude or Codex; both retain independent review.' : `Optional task ${label.toLowerCase()} for Codex working turns; Claude’s running chat uses its own controls.`)));
    case 'scope': return scopeQuestion(f); // The short tracking command already supplied the value.
    case 'choose': return [...valueQuestion(f), ...scopeQuestion(f)];
    default: throw new Error('invalid settings menu stage');
  }
}
export function advanceSettingsMenu(grant, answers) {
  const f = grant.flow;
  const labels = grant.questions.map(q => answers[q.question]);
  // A cancellation or Back in either question never applies the other answer.
  if (labels.some(label => label === 'Cancel')) return { cancelled: true };
  if (labels.some(label => label === 'Back')) {
    const previous = f.history.pop();
    if (previous) Object.assign(f, previous);
    grant.questions = menuQuestions(f); grant.questionToolId = null;
    return { questions: grant.questions };
  }
  if (labels.some(label => typeof label !== 'string' || label.length > 200)) return null;
  const valid = labels.every((label, index) => grant.questions[index].options.some(o => o.label === label) || index === 0 && f.stage === 'choose' && (f.target.endsWith('.model') && modelId(label) || f.target.endsWith('.effort') && ['minimal', 'xhigh', 'max', 'ultra', 'persistent'].includes(label)));
  if (!valid) return null;
  const label = labels[0];
  if (f.stage === 'choose' || f.stage === 'scope') {
    f.scope = scopes[labels.at(-1)];
    if (f.stage === 'choose') f.value = label === 'Use default' ? 'inherit' : label === 'Use normal model' ? null : ({ On: 'on', Off: 'off', Claude: 'claude', Codex: 'codex' })[label] ?? label;
    grant.selection = menuSelection(f);
    return { selection: grant.selection, summary: menuSummary(f) };
  }
  const previous = { stage: f.stage, target: f.target, scope: f.scope, value: f.value, context: structuredClone(f.context) };
  switch (f.stage) {
    case 'section': f.stage = ({ Models: 'models', 'Who does what': 'task', 'Weekly usage': 'choose' })[label]; if (label === 'Weekly usage') { f.target = 'tracking'; f.context.settingLabel = 'Weekly usage'; } break;
    case 'models':
      if (label === 'Claude model and effort') f.stage = 'claude';
      else { f.target = label === 'Codex model' ? 'partners.codex.model' : 'partners.codex.effort'; f.context.settingLabel = label; f.stage = 'choose'; } break;
    case 'task': f.target = `roles.${TASKS[label]}.executor`; f.context.taskLabel = label; f.context.taskNote = label === 'Testing' ? 'Changes cover writing and running tests together.' : ''; f.stage = 'control'; break;
    case 'control': f.target = f.target.replace(/\.[^.]+$/, `.${controls[label]}`); f.context.settingLabel = `${f.context.taskLabel}: ${label}`; f.stage = 'choose'; break;
    default: return null;
  }
  f.history.push(previous); grant.questionToolId = null; grant.questions = menuQuestions(f);
  return { questions: grant.questions };
}
export function menuSelection(f) { return `${f.target}=${f.value === 'inherit' ? 'inherit' : JSON.stringify(f.value)} scope=${f.scope}`; }
export function menuSummary(f) {
  const setting = f.context.settingLabel ?? 'Weekly usage';
  const value = f.value === 'inherit' ? ({ session: 'use the milestone/project setting', milestone: 'use the project setting', project: 'use the normal default' })[f.scope] : f.value === null ? 'use the main/default model' : f.value;
  const scope = f.scope === 'project' ? `project ${f.context.project}` : f.scope === 'milestone' ? `milestone ${f.context.milestone}` : 'this conversation';
  return `${setting}: ${value}, for ${scope}; effective on the next applicable turn unless a more specific setting takes precedence.`;
}
export function validateSettingsMenu(g) {
  const f = g.flow;
  if (!f || !Array.isArray(f.history) || f.history.length > 8 || !f.context || typeof f.context.project !== 'string' || typeof f.context.milestone !== 'string' || typeof f.context.claude !== 'string' || !Array.isArray(f.context.models) || f.context.models.length > 2 || !f.context.models.every(modelId) || f.target !== null && !targets.includes(f.target) || f.scope !== null && !Object.values(scopes).includes(f.scope) || g.questionToolId !== null && (typeof g.questionToolId !== 'string' || g.questionToolId.length > 200) || !isDeepStrictEqual(g.questions, menuQuestions(f)) || g.selection !== null && (!['choose', 'scope'].includes(f.stage) || !f.scope || g.selection !== menuSelection(f))) throw new Error('invalid settings menu grant');
}
export function typedSettingsReference() {
  return {
    scope: 'scope=session (conversation), scope=milestone (plan stage), scope=project (project default)',
    restore: 'Use value=inherit to remove an override at the selected scope; model=null uses the normal model.',
    models: ['/fabex:settings partners.codex.model=MODEL_ID scope=session', '/fabex:settings partners.codex.effort=high scope=session'],
    tasks: Object.fromEntries(Object.entries(TASKS).map(([label, role]) => [label, [`/fabex:settings roles.${role}.executor=codex scope=session`, `/fabex:settings roles.${role}.model=MODEL_ID scope=session`, `/fabex:settings roles.${role}.effort=high scope=session`]])),
    tracking: ['/fabex:settings tracking=on scope=project', '/fabex:settings tracking=off scope=milestone', '/fabex:settings tracking=inherit scope=milestone']
  };
}
