import { isDeepStrictEqual } from 'node:util';
export const TASKS = { Coding: 'implementation', Testing: 'testing', 'Image review': 'imageReview', Documentation: 'docs' };
const scopes = { 'Only this conversation': 'session', 'This milestone': 'milestone', 'Whole project': 'project' };
const option = (label, description) => ({ label, description });
const keep = () => option('Keep current', 'Leave this choice unchanged.');
const reset = () => option('Default', 'Remove this override and use the broader setting.');
const q = (header, question, options) => ({ header, question, multiSelect: false, options });
const actions = (extra, f) => q('Navigation', `Save these choices, go back, or cancel without saving.${Object.keys(f.draft).length ? ' Pending: ' + menuSummary(f) : ''}`, [option('Apply', 'Save all selected changes together.'), ...(extra ? [option(extra, 'Choose Codex’s model and effort for this task; Claude uses its host controls.')] : []), option('Back', 'Return without saving; pending selections are kept.'), option('Cancel', 'Close without saving anything.')]);
const keyPrefix = f => f.stage === 'models' ? 'partners.codex' : `roles.${f.task}`;
const keyValue = (f, key) => f.draft[key] === 'inherit' ? null : f.draft[key] ?? f.context.values[key];
function modelFor(f) { const requested = keyValue(f, `${keyPrefix(f)}.model`) ?? keyValue(f, 'partners.codex.model') ?? f.context.defaultModel; return requested ? f.context.models.find(m => m.id === requested) : f.context.models.find(m => m.isDefault); }
function scopeQuestion(f) {
  return q('Apply to', `Where should these changes apply? Current choice: ${f.scope === 'project' ? f.context.project : f.scope === 'milestone' ? f.context.milestone : 'only this conversation'}.`, [keep(), ...Object.entries(scopes).filter(([,v]) => v !== 'milestone' || f.context.milestone).map(([label, value]) => option(label, value === 'project' ? f.context.project : value === 'milestone' ? f.context.milestone : 'Overrides the milestone or project in this conversation.'))]);
}
function choices(values, page, more) {
  const selected = values.length ? [option(values[page % values.length], 'Reported by the current Codex account’s model list.')] : [];
  return [keep(), reset(), ...selected, ...(values.length > 1 ? [option(more, 'Show the next available choice; keep pending selections.')] : [])];
}
export function startSettingsMenu(args, context) {
  const flow = { version: 2, stage: args ? 'tracking' : 'section', scope: 'session', task: null, draft: args ? { tracking: args.split('=')[1] } : {}, pages: { model: 0, effort: 0 }, context };
  return { flow, questions: menuQuestions(flow), selection: null, questionToolId: null };
}
function screenQuestions(f) {
  const c = f.context;
  if (f.stage === 'section') return [q('Settings', 'What would you like to view or change?', [option('Models', 'Choose Codex’s model and reasoning effort; see Claude controls.'), option('Who does what', 'Coding, Testing, Image review, or Documentation.'), option('Weekly usage', 'Turn optional usage reports on or off.'), option('Cancel', 'Close without saving.')])];
  if (f.stage === 'tasks') return [q('Task', 'Which task would you like to set up?', Object.keys(TASKS).map(label => option(label, label === 'Documentation' ? 'Both is the default: two independently written, labeled contributions.' : 'Choose who does this task.'))), q('Navigation', 'Open this task or return to the settings sections.', [option('Continue', 'Open the selected task.'), option('Back', 'Return without saving.'), option('Cancel', 'Close without saving.')])];
  if (f.stage === 'task') return [q('Writer', `${Object.keys(TASKS).find(k => TASKS[k] === f.task)}: who does it? Current: ${keyValue(f, `roles.${f.task}.executor`) ?? c.values['roles.testWriting.executor']}.`, [keep(), option('Claude', 'Claude does the work; independent review remains.'), option('Codex', 'Codex does the work; independent review remains.'), ...(f.task === 'docs' ? [option('Both', 'Each writes its own contribution before seeing the other’s; neither rewrites the other.')] : [reset()])]), scopeQuestion(f), q('Defaults', 'Use the project or milestone writer instead? Default overrides the Writer tab; model and effort are unchanged.', [keep(), reset()]), actions('Model options', f)];
  if (f.stage === 'tracking') return [q('Weekly usage', `Weekly usage reports. Current: ${f.draft.tracking ?? c.values['usageTracker.mode']}.`, [keep(), option('On', 'Record and report usage when the tracker is available.'), option('Off', 'No tracking calls or ordinary usage reminders.'), reset()]), scopeQuestion(f), actions(null, f)];
  if (['models', 'taskModels'].includes(f.stage)) {
    const executor = f.stage === 'models' ? 'codex' : keyValue(f, `roles.${f.task}.executor`);
    const ids = executor === 'claude' ? [] : c.models.map(m => m.id);
    const model = modelFor(f), prefix = keyPrefix(f);
    const note = executor === 'claude' ? 'Claude’s running model and effort must be changed through its host controls.' : c.catalogError ?? 'Only models reported by Codex are offered. Availability is checked again when used.';
    const efforts = executor === 'claude' ? [] : model?.efforts ?? [];
    return [q('Codex model', `${note} Claude: ${c.claude}; change it with /model. Pending/current Codex model: ${keyValue(f, `${prefix}.model`) ?? 'default'}. Available models: ${ids.join(', ') || 'none reported'}. You can type an exact listed name in Other.`, choices(ids, f.pages.model, 'More models')), q('Codex effort', `How much reasoning should Codex request? Model: ${model?.id ?? 'unavailable'}. Pending/current effort: ${keyValue(f, `${prefix}.effort`) ?? 'default'}. Available effort levels: ${efforts.join(', ') || 'none reported'}. You can type an exact supported level in Other.`, choices(efforts, f.pages.effort, 'More effort levels')), scopeQuestion(f), actions(null, f)];
  }
  throw new Error('Invalid settings screen.');
}
export function menuQuestions(f) {
  const questions = screenQuestions(f);
  if (f.notice) questions[0].question = `${f.notice} ${questions[0].question}`;
  return questions;
}
function move(grant) { grant.questionToolId = null; grant.questions = menuQuestions(grant.flow); return { questions: grant.questions }; }
export function advanceSettingsMenu(grant, answers) {
  const f = grant.flow, labels = grant.questions.map(question => answers[question.question]);
  if (labels.includes('Cancel')) return { cancelled: true };
  if (!labels.every(label => typeof label === 'string')) return null;
  const modelTabs = ['models', 'taskModels'].includes(f.stage);
  const codexChoices = modelTabs && (f.stage === 'models' || keyValue(f, `roles.${f.task}.executor`) !== 'claude');
  // Validate effort against the model chosen in this same tabbed submission,
  // including names not on the current button page. Never infer availability.
  const candidate = { ...f, draft: { ...f.draft } };
  if (codexChoices) {
    if (labels[0] === 'Default') candidate.draft[`${keyPrefix(f)}.model`] = 'inherit';
    else if (f.context.models.some(m => m.id === labels[0])) candidate.draft[`${keyPrefix(f)}.model`] = labels[0];
  }
  const valid = labels.every((label, i) => {
    if (codexChoices && i === 0 && f.context.models.some(m => m.id === label)) return true;
    if (codexChoices && i === 1 && !['Keep current', 'Default', 'More effort levels'].includes(label)) return modelFor(candidate)?.efforts.includes(label) === true;
    return grant.questions[i].options.some(o => o.label === label);
  });
  if (!valid) { f.notice = 'Please pick one of the choices.' + (modelTabs ? ' Model names and effort levels must exactly match the reported list.' : ''); return move(grant); }
  delete f.notice;
  const goBack = () => { f.stage = f.stage === 'taskModels' ? 'task' : f.stage === 'task' ? 'tasks' : 'section'; return move(grant); };
  if (labels.includes('Back') && ['section', 'tasks'].includes(f.stage)) return goBack();
  if (f.stage === 'section') { f.stage = ({ Models: 'models', 'Who does what': 'tasks', 'Weekly usage': 'tracking' })[labels[0]]; return move(grant); }
  if (f.stage === 'tasks') { f.task = TASKS[labels[0]]; f.stage = 'task'; return move(grant); }
  const scopeLabel = labels[f.stage === 'models' || f.stage === 'taskModels' ? 2 : 1];
  if (scopeLabel !== 'Keep current') f.scope = scopes[scopeLabel];
  const put = (key, label) => { if (label !== 'Keep current') f.draft[key] = label === 'Default' ? 'inherit' : ({ Claude: 'claude', Codex: 'codex', Both: 'both', On: 'on', Off: 'off' })[label] ?? label; };
  if (f.stage === 'tracking') put('tracking', labels[0]);
  if (f.stage === 'task') {
    put(`roles.${f.task}.executor`, labels[0]);
    if (labels[2] === 'Default') f.draft[`roles.${f.task}.executor`] = 'inherit';
    if (labels.includes('Back')) return goBack();
    if (labels[3] === 'Model options') { f.stage = 'taskModels'; return move(grant); }
  }
  if (['models', 'taskModels'].includes(f.stage)) {
    const prefix = keyPrefix(f);
    if (labels[0] === 'More models') f.pages.model++; else put(`${prefix}.model`, labels[0]);
    if (labels[1] === 'More effort levels') f.pages.effort++; else put(`${prefix}.effort`, labels[1]);
    if (labels.includes('Back')) return goBack();
    if (labels.includes('More models') || labels.includes('More effort levels')) return move(grant);
    const model = modelFor(f), effort = keyValue(f, `${prefix}.effort`);
    if (Object.keys(f.draft).some(key => key.endsWith('.model') || key.endsWith('.effort')) && effort && model && !model.efforts.includes(effort)) { f.notice = 'That model does not offer this effort. Choose a supported level or Default.'; return move(grant); }
  }
  if (labels.includes('Back')) return goBack();
  if (!Object.keys(f.draft).length) return { cancelled: true, unchanged: true };
  grant.selection = menuSelection(f);
  grant.questions = menuQuestions(f);
  return { selection: grant.selection, summary: menuSummary(f) };
}
export function menuSelection(f) { return Object.entries(f.draft).map(([key,value]) => `${key}=${value === 'inherit' ? 'inherit' : JSON.stringify(value)}`).join(' ') + ` scope=${f.scope}`; }
export function menuSummary(f) {
  const labels = { tracking: 'Weekly usage', 'partners.codex.model': 'Codex model', 'partners.codex.effort': 'Codex effort', ...Object.fromEntries(Object.entries(TASKS).flatMap(([label, role]) => [['executor', 'writer'], ['model', 'Codex model'], ['effort', 'Codex effort']].map(([key, name]) => [`roles.${role}.${key}`, `${label} ${name}`]))) };
  return Object.entries(f.draft).map(([key,v]) => `${labels[key] ?? key.replace(/^roles\./, '').replace(/\.executor$/, ' writer').replace(/\./g, ' ')}: ${v === 'inherit' ? 'use the broader setting' : v}`).join('; ') + ` — ${f.scope === 'project' ? 'project ' + f.context.project : f.scope === 'milestone' ? 'milestone ' + f.context.milestone : 'only this conversation'}.`;
}
export function validateSettingsMenu(g) {
  const f = g.flow;
  if (f && f.version === undefined) return; // Read pre-upgrade grants; applying them requires reopening settings.
  if (!f || f.version !== 2 || !f.context || !Array.isArray(f.context.models) || f.context.models.length > 200 || !f.draft || typeof f.draft !== 'object' || !['session','milestone','project'].includes(f.scope) || f.scope === 'milestone' && !f.context.milestone || !isDeepStrictEqual(g.questions, menuQuestions(f)) || g.selection !== null && g.selection !== menuSelection(f) || g.questionToolId !== null && typeof g.questionToolId !== 'string') throw new Error('invalid settings menu grant');
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
