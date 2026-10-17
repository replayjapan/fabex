#!/usr/bin/env node
import { reviewSessionMatches } from './lib/work-disposition.mjs';
import { activityDecision, observeActivity, activitySnapshot, researchAuthorAllowed } from './lib/activity.mjs';
import { simpleTokens, safeCommandSegments, readOnlyGithub, readOnlySed, readOnlyGit, readOnlyTagArgs } from './vendor/modes/shell.mjs';
export { readOnlyGithub, readOnlySed };
import { decodeEdits } from './vendor/modes/edits.mjs';
import { writableTarget } from './vendor/modes/policy.mjs';
import { writePlan } from './vendor/modes/contained-edits.mjs';
import { readPlan } from './vendor/modes/runner.mjs';
import { authorshipPolicy, isDocumentationTarget, isTestTarget } from './lib/authorship.mjs';
import { recordWorkspaceQuestion, matchesWorkspaceQuestion } from './lib/workspace.mjs';
import { resolveSettings, executionPlan, ROLE_NAMES } from './lib/workspace-settings.mjs';
import { basename, dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT, rootFromHookInput } from './lib/paths.mjs';
import { loadEffectiveConfig } from './lib/config.mjs';
import { readState } from './lib/state.mjs';
import { attachmentSessionId, normalizeSubmissionEnvelope } from './lib/sdk-controller.mjs';
import { attachmentShape, validateAttachments } from './lib/attachments.mjs';
import { modeGrantMatches, modeTargetForSkill } from './lib/hook-evidence.mjs';
import { isPlainObject, UUID_RE } from './lib/validation.mjs';
import { developmentProbe } from './lib/development.mjs';
import { beginHeavy, heavyShape, wrappedHeavyInput } from './lib/heavy.mjs';
import { ownerDeliveries, deliveryObligations, ownsResearchHelper, blockingReviewWarning } from './lib/owner-delivery.mjs';
import { refreshState } from './lib/conversation-refresh.mjs';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SKILL_TOOLS = new Set(['Skill', 'SlashCommand']);
const BARE_SKILLS = new Set(['status', 'diagnose', 'recover', 'session', 'settings', 'milestone']);
const CONTROL_PATH = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
const CONTROLLER_PATH = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
const SAFE_UNHEALTHY = new Set(['help', 'checkpoint-help', 'status', 'config', 'diagnose', 'controller-help', 'controller-status', 'controller-result', 'controller-cancel', 'controller-wait', 'clear-dead-lock', 'recover-inspect', 'recover-abandon', 'recover-replace-missing-thread', 'recover-resolve-transaction', 'mode-normal', 'mode-discussion', 'mode-ask-once']);
for (const kind of ['mem', 'prompts', 'heavy-status', 'heavy-wait', 'resources-list']) SAFE_UNHEALTHY.add(kind);
const OPERATIONAL_AGENT = 'fabex-operational';
// Plugin-defined agents are reported by the hook harness with their plugin-scoped type.
// Reject the bare agent name so an identity outside that contract cannot gain push authority.
const OPERATIONAL_AGENT_TYPE = 'fabex:fabex-operational';
const IMAGE_REFERENCE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg|heic|heif|avif|ico)(?=$|[\s"'?#)\],;])/i;

function referencesImage(value) {
  if (typeof value === 'string') return IMAGE_REFERENCE.test(value);
  if (Array.isArray(value)) return value.some(referencesImage);
  return isPlainObject(value) && Object.values(value).some(referencesImage);
}

const GIT_OPTIONS_WITH_VALUES = new Set(['-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);


function executableName(token) {
  return basename(token ?? '').replace(/\.exe$/i, '').toLowerCase();
}

function protectedGitOperation(tokens, gitIndex) {
  let index = gitIndex + 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    if (GIT_OPTIONS_WITH_VALUES.has(option)) index += 2;
    else index += 1;
  }
  const subcommand = tokens[index];
  if (subcommand === 'tag' && readOnlyTagArgs(tokens.slice(index + 1))) return null;
  if (['add', 'commit', 'tag', 'merge', 'rebase', 'cherry-pick', 'push', 'send-pack'].includes(subcommand)) return `git ${subcommand} operation`;
  if (subcommand === 'lfs' && tokens[index + 1] === 'push') return 'Git LFS push operation';
  return null;
}

function protectedSimpleCommand(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  const executable = executableName(tokens[index]);
  if (executable === 'gh') return readOnlyGithub(tokens.slice(index + 1)) ? null : 'GitHub CLI operation';
  if (executable === 'git') return protectedGitOperation(tokens, index);
  if (['bash', 'dash', 'fish', 'sh', 'zsh'].includes(executable)) {
    const commandIndex = tokens.indexOf('-c', index + 1);
    if (commandIndex !== -1 && typeof tokens[commandIndex + 1] === 'string') return protectedGithubOperation(tokens[commandIndex + 1]);
  }
  if (['command', 'env', 'exec', 'nohup', 'sudo', 'xcrun'].includes(executable)) {
    for (let candidate = index + 1; candidate < tokens.length; candidate += 1) {
      const nested = executableName(tokens[candidate]);
      if (nested === 'gh') return readOnlyGithub(tokens.slice(candidate + 1)) ? null : 'GitHub CLI operation';
      if (nested === 'git') return protectedGitOperation(tokens, candidate);
    }
  }
  return null;
}

export function protectedGithubOperation(command) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) return null;
  const tokens = simpleTokens(command);
  if (tokens) return protectedSimpleCommand(tokens);
  const segments = safeCommandSegments(command);
  if (segments) return segments.map((segment) => protectedSimpleCommand(simpleTokens(segment) ?? [])).find(Boolean) ?? null;
  const boundary = String.raw`(?:^|[;&|()\r\n])\s*`;
  const wrappers = String.raw`(?:(?:command|env|exec|nohup|sudo|xcrun)\s+)*`;
  const path = String.raw`(?:[^\s;&|()]+\/)*`;
  const commandEnd = String.raw`(?=\s|[;&|()\r\n]|$)`;
  const gh = new RegExp(`${boundary}${wrappers}${path}gh(?:\\.exe)?${commandEnd}`, 'i');
  if (gh.test(command)) return 'ambiguous or composed GitHub CLI operation';
  const git = new RegExp(`${boundary}${wrappers}${path}git(?:\\.exe)?\\s+[^;&|()\\r\\n]{0,512}\\b(?:add|commit|tag|merge|rebase|cherry-pick|push|send-pack|lfs\\s+push)${commandEnd}`, 'i');
  if (git.test(command)) return 'ambiguous or composed protected git operation';
  return null;
}

function isOperationalExecutor(executor) {
  return typeof executor?.agentId === 'string'
    && executor.agentId.trim().length > 0
    && executor.agentType === OPERATIONAL_AGENT_TYPE;
}

export function parseControlCommand(command) {
  if (typeof command === 'string' && command.includes('\n')) {
    const lines = command.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const header = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+checkpoint\s+(replace\s+(constraint|decision|relevant-file|unresolved-problem|open-work)|snapshot)\s+<<'([A-Za-z][A-Za-z0-9_]{7,63})'$/.exec(lines[0] ?? '');
    if (header && resolve(header[1] ?? header[2] ?? header[3]) === CONTROL_PATH && lines.at(-1) === header[6]) {
      const body = lines.slice(1, -1).join('\n');
      if (Buffer.byteLength(body, 'utf8') <= 48 * 1024) return { kind: header[4] === 'snapshot' ? 'checkpoint-snapshot' : 'checkpoint-replace' };
    }
  }
  const tokens = simpleTokens(command);
  if (!tokens || basename(tokens[0] ?? '') !== 'node' || resolve(tokens[1] ?? '') !== CONTROL_PATH) return null;
  const args = tokens.slice(2);
  if (args[0] === 'settings' && (args.length === 2 && args[1] === '--json' || args.length === 4 && args[1] === '--session' && args[2] && args[3] === '--json')) return { kind: 'workspace-view', sessionId: args[1] === '--session' ? args[2] : undefined };
  if (args.length === 1 && ['settings', 'milestone', 'session'].includes(args[0])) return { kind: 'workspace-view' };
  if (args.length === 3 && ['settings', 'milestone', 'session'].includes(args[0]) && args[1] === '--session' && args[2]) return { kind: 'workspace-view', sessionId: args[2] };
  if (args.length === 2 && args[0] === 'role' && ROLE_NAMES.includes(args[1])) return { kind: 'task-role' };
  if (args[0] === 'milestone' && ['handoff', 'rotate'].includes(args[1]) && args[2] === '--review' && UUID_RE.test(args[3] ?? '') && (args[1] === 'handoff' ? args.length === 5 && Buffer.byteLength(args[4]) <= 8000 : args.length === 4)) return { kind: 'milestone-checkpoint' };
  if (args.length === 4 && args[0] === 'settings' && args[1] === 'apply' && args[2] === '--grant' && UUID_RE.test(args[3])) return { kind: 'workspace-apply', grantId: args[3] };
  if (args[0] === 'usage' && args.length === 2 && args[1] === 'report') return { kind: 'usage-report' };
  if (args[0] === 'usage' && [4, 6].includes(args.length) && args[1] === 'snapshot' && args[2] === '--event' && ['start', 'checkpoint', 'progress', 'end'].includes(args[3]) && (args.length === 4 || args[4] === '--checkpoint' && /^[A-Za-z0-9._-]{1,80}$/.test(args[5]))) return { kind: 'usage-snapshot' };
  if (args.length === 1 && ['mem', 'prompts'].includes(args[0])) return { kind: args[0] };
  if (args[0] === 'heavy' && args.length === 2 && ['status', 'wait'].includes(args[1])) return { kind: `heavy-${args[1]}` };
  if (args[0] === 'heavy' && args[1] === 'release' && args.length === 3 && args[2].length <= 300) return { kind: 'heavy-release' };
  if (args[0] === 'recover' && args[1] === 'heavy' && args.length === 3 && args[2].length <= 300) return { kind: 'heavy-recover' };
  if (args[0] === 'heavy' && args[1] === 'wait' && args.length === 4 && args[2] === '--timeout' && /^\d+$/.test(args[3]) && Number(args[3]) >= 1 && Number(args[3]) <= 120) return { kind: 'heavy-wait' };
  if (args[0] === 'resources' && args[1] === 'list' && args.length === 2) return { kind: 'resources-list' };
  if (args[0] === 'resources' && /^[A-Za-z0-9._:-]{1,160}$/.test(args[2] ?? '') && (args[1] === 'release' && args.length === 3 || args[1] === 'retain' && args.length === 5 && args[3] === '--note' && args[4].trim())) return { kind: `resources-${args[1]}` };
  if (args[0] === 'dev' && args.length === 2 && ['start', 'stop', 'restart', 'status', 'logs'].includes(args[1])) return { kind: `dev-${args[1]}` };
  if (args[0] === 'dev' && args[1] === 'logs' && args.length === 4 && args[2] === '--lines' && /^[1-9]\d{0,2}$/.test(args[3]) && Number(args[3]) <= 400) return { kind: 'dev-logs' };
  if (args.length === 0 || args.length === 1 && args[0] === '--help') return { kind: 'help' };
  if (args[0] === 'status' && (args.length === 1 || args.length === 2 && ['--all', '--brief'].includes(args[1]))) return { kind: 'status' };
  if (['config', 'diagnose'].includes(args[0]) && args.length === 1) return { kind: args[0] };
  if (args[0] === 'cleanup' && args.length === 3 && args[1] === '--path' && isAbsolute(args[2]) && /^fabex-next(?:-\d+\.\d+\.\d+)?$/.test(basename(args[2]))) return { kind: 'cleanup' };
  if (args[0] === 'cleanup' && args.length === 5 && args[1] === '--path' && args[3] === '--source' && isAbsolute(args[2]) && isAbsolute(args[4])) return { kind: 'cleanup' };
  if (args[0] === 'checkpoint' && (args.length === 1 || args.length === 2 && args[1] === '--help')) return { kind: 'checkpoint-help' };
  if (args[0] === 'checkpoint' && ['capacity', 'export'].includes(args[1]) && args.length === 2) return { kind: `checkpoint-${args[1]}` };
  const fields = new Set(['objective', 'current-task', 'constraint', 'decision', 'relevant-file', 'implementation-status', 'test-status', 'unresolved-problem', 'next-action', 'open-work', 'owner-action-required', 'blocker']);
  if (args[0] === 'checkpoint' && args[1] === 'clear' && ['open-work', 'owner-action-required', 'blocker'].includes(args[2]) && args.length === 3) return { kind: 'checkpoint-continuation' };
  if (args[0] === 'checkpoint' && ['owner-action-required', 'blocker'].includes(args[1]) && args[2] === '--clear' && args.length === 3) return { kind: 'checkpoint-continuation' };
  if (args[0] === 'checkpoint' && fields.has(args[1]) && typeof args[2] === 'string' && args[2].length > 0 && Buffer.byteLength(args[2], 'utf8') <= 8192 && args.length === 3) return { kind: 'checkpoint' };
  if (args[0] === 'checkpoint' && args[1] === 'compact' && ['constraint', 'decision', 'relevant-file', 'unresolved-problem'].includes(args[2]) && args[3] === '--keep-last' && /^\d+$/.test(args[4] ?? '') && args.length === 5) return { kind: 'checkpoint-compact' };
  if (args[0] === 'executor-exception' && args[1] === 'authorize' && args.length === 8 && args[2] === '--executor' && args[4] === '--scope' && args[6] === '--reason' && args[3] && args[5] && args[7]) return { kind: 'executor-exception-authorize' };
  if (args[0] === 'executor-exception' && args[1] === 'reconcile' && args.length === 4 && args[2] === '--outcome' && args[3]) return { kind: 'executor-exception-reconcile' };
  if (args[0] === 'mode' && ['normal', 'discussion', 'ask-once'].includes(args[1])) {
    const offset = args[2] === '--participants' ? 6 : 4;
    const participants = offset === 6 ? args[3] : 'both';
    if (!['both', 'claude', 'codex'].includes(participants) || args[offset - 2] !== '--grant' || !UUID_RE.test(args[offset - 1] ?? '') || (args.length - offset) % 2 || args.length < offset || args.slice(offset).some((arg, index) => index % 2 === 0 && arg !== '--attach')) return null;
    try {
      const attachments = attachmentShape(args.slice(offset).filter((_, index) => index % 2 === 1));
      return { kind: `mode-${args[1]}`, route: args[1], participants, grantId: args[offset - 1], attachments };
    } catch { return null; }
  }
  if (args[0] === 'recover' && args[1] === 'clear-dead-lock' && args.length === 2) return { kind: 'clear-dead-lock' };
  if (args[0] === 'recover' && args[1] === 'resolve-transaction' && args.length === 3 && ['--commit', '--discard'].includes(args[2])) return { kind: 'recover-resolve-transaction' };
  if (args[0] === 'recover' && ['inspect', 'abandon', 'replace-missing-thread'].includes(args[1]) && args.length === 4 && args[2] === '--operation-id' && UUID_RE.test(args[3])) return { kind: `recover-${args[1]}` };
  return null;
}

export function parseControllerCommand(command, { participants = null } = {}) {
  if (typeof command === 'string' && command.includes('\n')) {
    const lines = command.trimEnd().split('\n');
    const match = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+seal\s+--operation-id\s+([a-f0-9-]{36})\s+<<'([A-Za-z][A-Za-z0-9_]{7,63})'$/.exec(lines[0]);
    if (match && resolve(match[1] ?? match[2] ?? match[3]) === CONTROLLER_PATH && UUID_RE.test(match[4]) && lines.at(-1) === match[5] && Buffer.byteLength(lines.slice(1, -1).join('\n')) <= 16000) return { kind: 'controller-seal', operationId: match[4] };
  }
  const acceptedSubmit = (message) => {
    if (participants !== null) {
      try { normalizeSubmissionEnvelope(message, participants); } catch { return null; }
    }
    return { kind: 'controller-submit', message };
  };
  if (typeof command === 'string' && command.includes('\n')) {
    const lines = command.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const header = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+submit\s+<<'([A-Za-z][A-Za-z0-9_]{7,63})'$/.exec(lines[0] ?? '');
    if (header && resolve(header[1] ?? header[2] ?? header[3]) === CONTROLLER_PATH && lines.at(-1) === header[4]) {
      const message = lines.slice(1, -1).join('\n');
      if (message.trim() && Buffer.byteLength(message, 'utf8') <= 192 * 1024) return acceptedSubmit(message);
    }
  }
  const tokens = simpleTokens(command);
  if (!tokens || basename(tokens[0] ?? '') !== 'node' || resolve(tokens[1] ?? '') !== CONTROLLER_PATH) return null;
  const args = tokens.slice(2);
  if ((args.length === 0 || args.length === 1 && ['--help', 'help'].includes(args[0]))) return { kind: 'controller-help' };
  if (args[0] === 'continue' && (args.length === 3 || args.length === 5 && args[3] === '--disposition') && args[1] === '--operation-id' && UUID_RE.test(args[2])) return { kind: 'controller-continue', operationId: args[2] };
  if (args[0] === 'submit' && args.length === 3 && args[1] === '--message' && typeof args[2] === 'string' && args[2].length > 0 && Buffer.byteLength(args[2], 'utf8') <= 192 * 1024) return acceptedSubmit(args[2]);
  if (['status', 'result', 'relay', 'cancel'].includes(args[0]) && args.length === 3 && args[1] === '--operation-id' && UUID_RE.test(args[2])) return { kind: `controller-${args[0]}` };
  if (args[0] === 'relay' && args.length === 4 && args[1] === '--operation-id' && UUID_RE.test(args[2]) && args[3] === '--full') return { kind: 'controller-relay' };
  if (args[0] === 'wait' && args.length === 5 && args[1] === '--operation-id' && UUID_RE.test(args[2]) && args[3] === '--timeout' && /^\d+$/.test(args[4]) && Number(args[4]) >= 1 && Number(args[4]) <= 120) return { kind: 'controller-wait' };
  return null;
}

function invokesFabexScript(command, path) {
  const tokens = simpleTokens(command);
  if (tokens && basename(tokens[0] ?? '') === 'node' && resolve(tokens[1] ?? '') === path) return true;
  if (typeof command !== 'string') return false;
  const first = command.split('\n', 1)[0];
  const match = /^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/.exec(first);
  return Boolean(match && resolve(match[1] ?? match[2] ?? match[3]) === path);
}

function isPluginSkill(toolName, input) {
  if (!SKILL_TOOLS.has(toolName)) return false;
  const invocation = toolName === 'Skill' ? input.skill : input.command;
  if (typeof invocation !== 'string') return false;
  const name = invocation.replace(/^\//, '');
  return name.startsWith('fabex:') || BARE_SKILLS.has(name);
}

function modeSkillTarget(toolName, input) {
  if (!SKILL_TOOLS.has(toolName)) return null;
  const name = toolName === 'Skill' ? input.skill : input.command;
  return modeTargetForSkill(name) ?? (/^\/?(?:fabex:)?(?:work|discussion|ask)(?:Claude|Codex)?$/.test(name ?? '') ? { retired: true } : null);
}

function executorNames(executor) {
  if (!(typeof executor?.agentId === 'string' && executor.agentId.trim())) return new Set(['claude', 'claude-main', 'main-session']);
  return new Set([executor.agentId, executor.agentType].filter(Boolean).map((value) => value.toLowerCase()));
}

function activeExecutorException(state, toolName, executor) {
  // Main partners change authority through Coding; exceptions are for named helpers.
  if (typeof executor?.agentId !== 'string' || !executor.agentId.trim()) return false;
  const active = state.executorException;
  if (!active || ['claude', 'claude-main', 'codex', 'codex-main', 'main-session'].includes(active.executor.toLowerCase()) || !executorNames(executor).has(active.executor.toLowerCase())) return false;
  return ['project file edits', 'all edits', toolName.toLowerCase(), 'all writes'].includes(active.scope.toLowerCase());
}

function insideRoot(target, root) {
  if (typeof target !== 'string' || !target) return true;
  const absolute = resolve(root, target);
  const pathFromRoot = relative(root, absolute);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function writeTarget(input) {
  return input.file_path ?? input.path ?? input.notebook_path ?? input.filePath ?? null;
}

const BASE_READ_COMMANDS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'diff', 'stat', 'file', 'which', 'echo', 'printf', 'pwd', 'env']);


function commandIndex(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  return index;
}

function commandPatternMatches(tokens, config, root) {
  const index = commandIndex(tokens);
  const executable = executableName(tokens[index]);
  const args = tokens.slice(index + 1);
  const repositoryBase = resolve(root, config?.project?.repositoryRoot ?? '.');
  return (config?.guard?.allowedCommandPatterns ?? []).some((pattern) => {
    if (executableName(pattern.executable) !== executable || pattern.args.length !== args.length) return false;
    return pattern.args.every((expected, argumentIndex) => {
      const actual = args[argumentIndex];
      if (expected === '*') return true;
      const scriptPath = executable === 'node' && argumentIndex === 0 && !expected.startsWith('-');
      if (!scriptPath) return actual === expected;
      const expectedPath = resolve(repositoryBase, expected);
      const actualPath = resolve(repositoryBase, actual);
      return insideRoot(expectedPath, root) && insideRoot(actualPath, root) && expectedPath === actualPath;
    });
  });
}

function allowedBashCommand(command, config, root) {
  const tokens = simpleTokens(command);
  if (!tokens) return false;
  if (developmentProbe(tokens)) return true;
  const index = commandIndex(tokens);
  const executable = executableName(tokens[index]);
  const args = tokens.slice(index + 1);
  if (executable === 'du') return args[0] === '-sh' && args.slice(1).every((arg) => !arg.startsWith('-'));
  if (executable === 'ps') return args.length === 2 && args[0] === '-axo' && /^(?:pid|ppid|rss|etime|stat|comm)(?:,(?:pid|ppid|rss|etime|stat|comm))*$/.test(args[1]);
  const extras = new Set((config?.guard?.allowedCommands ?? []).map((value) => executableName(value)));
  if (extras.has(executable)) return true;
  if (commandPatternMatches(tokens, config, root)) return true;
  if (executable === 'sed') return readOnlySed(args);
  if (executable === 'env') return args.length === 0;
  if (executable === 'find') return !args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg));
  if (BASE_READ_COMMANDS.has(executable)) return true;
  if (executable === 'node') {
    if (args.length === 1 && args[0] === '--version') return true;
    if (args[0] !== '--test') return false;
    if (args.length === 1) return true;
    const repositoryBase = resolve(root, config?.project?.repositoryRoot ?? '.');
    return args.slice(1).every((target) => target && !target.startsWith('-') && !target.includes(':') && insideRoot(resolve(repositoryBase, target), root));
  }
  if (['pnpm', 'npm', 'yarn'].includes(executable)) {
    const mutationFlags = new Set(['--update', '-u', '--update-snapshot', '--write', '--fix', '--force']);
    if (args.some((arg) => mutationFlags.has(arg) || [...mutationFlags].some((flag) => arg.startsWith(`${flag}=`)))) return false;
    const script = args[0] === 'run' ? args[1] : args[0];
    return ['test', 'lint', 'typecheck', 'build', 'check'].includes(script) || /^test:[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(script ?? '');
  }
  if (executable === 'npx') return ['vitest', 'jest', 'tsc'].includes(executableName(args[0])) && !args.some((arg) => ['--write', '--fix', '--update', '-u'].includes(arg));
  if (executable === 'git') return readOnlyGit(args);

  return false;
}



const SAFE_COMPOSED_CONTROLS = new Set(['status', 'config', 'diagnose', 'checkpoint-capacity', 'checkpoint-export', 'help', 'checkpoint-help', 'controller-status', 'controller-result', 'controller-wait', 'controller-help']);
SAFE_COMPOSED_CONTROLS.add('workspace-view');
SAFE_UNHEALTHY.add('controller-relay');
SAFE_COMPOSED_CONTROLS.add('controller-relay');
SAFE_COMPOSED_CONTROLS.add('dev-status');
SAFE_COMPOSED_CONTROLS.add('dev-logs');
SAFE_UNHEALTHY.add('controller-relay');

function allowedDiscussionReads(command, config, root) {
  const segments = safeCommandSegments(command);
  return Boolean(segments?.every((segment) => {
    const control = parseControlCommand(segment) ?? parseControllerCommand(segment);
    if (control) return SAFE_COMPOSED_CONTROLS.has(control.kind);
    const tokens = simpleTokens(segment);
    if (!tokens) return false;
    if (developmentProbe(tokens)) return true;
    const executable = executableName(tokens[commandIndex(tokens)]);
    const args = tokens.slice(commandIndex(tokens) + 1);
    if (commandIndex(tokens) !== 0) return false; // environment overrides can execute helpers
    if (executable === 'gh') return readOnlyGithub(args);
    if (executable === 'rg' && args.some(arg => /^(?:--pre|--hostname-bin)(?:=|$)/.test(arg))) return false;
    if (executable === 'file' && args.some(arg => arg === '-C' || arg === '--compile')) return false;
    if (executable === 'sed') return readOnlySed(args);
    if (['sort', 'uniq', 'cut', 'tr', 'column'].includes(executable)) {
      if (executable === 'sort' && args.some(arg => /^-o|^--output(?:=|$)/.test(arg))) return false;
      // uniq's second file operand is an output, unlike sort/cut inputs.
      if (executable === 'uniq') return args.filter(arg => !arg.startsWith('-')).length <= 1 && args.every(arg => !arg.startsWith('-') || /^-[cdu]+$/.test(arg));
      return true;
    }
    if (executable === 'jq') return !args.some(arg => ['--run-tests', '-f', '--from-file'].includes(arg));
    if (executable === 'awk') return args.length >= 1 && !args.some(arg => /(?:system|getline|close|fflush)\s*\(|[>|]/.test(arg) || /^-(?:f|i)/.test(arg));
    if (executable === 'xargs') return args.length > 0 && !args[0].startsWith('-') && allowedDiscussionReads(args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' '), config, root);
    if (executable === 'node') return args.length === 1 && args[0] === '--version';
    if (['pnpm', 'npm', 'yarn'].includes(executable)) {
      const rest = [...args];
      if (['--dir', '-C', '--prefix', '--cwd'].includes(rest[0])) rest.splice(0, 2);
      return ['list', 'ls', 'why', 'outdated', 'view', 'info'].includes(rest[0]) && rest.slice(1).every(arg => !arg.startsWith('-') || ['--json', '--all', '--long', '--parseable'].includes(arg));
    }
    if (executable === 'ps') return args.length === 0 || args[0] === '-axo' && args.length === 2 && args[1].split(',').every(field => ['pid', 'ppid', 'pgid', 'rss', 'etime', 'stat', 'comm', 'lstart'].includes(field));
    if (executable === 'pgrep') return args.length > 0 && args.every(arg => !arg.startsWith('-') || /^-[flinxv]+$/.test(arg));
    if (!BASE_READ_COMMANDS.has(executable) && !['sed', 'find', 'git', 'du', 'ps', 'pwd'].includes(executable)) return false;
    return allowedBashCommand(segment, { ...config, guard: { ...config?.guard, allowedCommands: [], allowedCommandPatterns: [] } }, root);
  }));
}

// These are targeted backstops, NOT a proof of arbitrary program effects.
// Executors must review the actual target and effects under the work policy.
function containedNpmPrefix(prefix, root, cwd) {
  if (!prefix || prefix.startsWith('-') || /[*?~$`]/.test(prefix)) return false;
  try {
    const target = realpathSync(resolve(cwd, prefix));
    return insideRoot(target, realpathSync(root)) && lstatSync(target).isDirectory();
  } catch { return false; }
}

export function workCommandDenial(command, root, cwd = root, config = null) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) return 'malformed command';
  if (allowedDiscussionReads(command, config, root)) return null;
  const destructive = [
    ['privileged execution', /(?:^|[\s;&|])sudo(?:\s|$)/i],
    ['database reset', /\b(?:migrat\w*|db)\s+(?:fresh|reset)\b/i],
    ['database drop', /\b(?:dropdb|DROP\s+(?:DATABASE|TABLE|SCHEMA))\b/i],
    ['production database mutation', /(?:NODE_ENV\s*=\s*["']?production|\.env\.production)[\s\S]*\b(?:migrat\w*|seed\w*|db:push)\b/i],
    ['production database mutation', /\b(?:migrat\w*|seed\w*|db:push)\b[\s\S]*(?:NODE_ENV\s*=\s*["']?production|\.env\.production)/i],
    ['deployment', /(?:^|[\s;&|])(?:vercel|netlify|fly|gcloud|aws|wrangler)\s+(?:[^;&|\n]*\s)?(?:deploy|publish)(?:\s|$)/i],
    ['deployment', /(?:^|[\s;&|])vercel(?:\s+--prod\b|\s*$)/i],
    ['unverified process termination', /(?:^|[\s;&|/])(?:kill|pkill|killall)(?:\s|$)/i]
  ];
  for (const [rule, pattern] of destructive) if (pattern.test(command)) return rule;
  if (/\b(?:git|gh)\b/.test(command) && /\$\(|`/.test(command)) return 'unparseable Git delivery substitution';
  if (/(?:^|[;&|]\s*)ps\s+(?:e|auxe|eww|-axo\s+(?:command|args|environment))(?:\s|$)/.test(command)) return 'unbounded process environment disclosure';
  if (/\b(?:xargs|find)\b[\s\S]*\b(?:rm|mv|cp|tee|touch|chmod|sed|perl)\b/.test(command) && !allowedDiscussionReads(command, config, root)) return 'project source authorship (indirect file command)';
  if (/(?:^|[\s;&|])(?:--fix|--write|--update|--update-snapshot)(?:\s|$)/.test(command)) return 'project source authorship (rewrite flag)';
  if (/\bfind\b[\s\S]*\s-delete\b/.test(command)) return 'project source authorship (find delete)';
  if (/\bgit\b[\s\S]*--output(?:=|\s)/.test(command)) return 'project source authorship (git output)';
  if (/\benv\s+(?:[\w]+=[^\s]+\s+)*(?:touch|rm|cp|mv|tee|sed|perl)\b/.test(command)) return 'project source authorship (env file command)';
  if (/\b(?:node|python\d*|ruby|perl)\s+(?:-e|-c)\b/.test(command) && /\b(?:writeFile\w*|appendFile\w*|unlink\w*|rename\w*|write_text|write_bytes|rmtree)\b/.test(command)) return 'project source authorship (inline writer)';
  for (const segment of safeCommandSegments(command) ?? []) {
    const words = simpleTokens(segment);
    if (words && executableName(words[commandIndex(words)]) === 'sed' && !readOnlySed(words.slice(commandIndex(words) + 1))) return 'unverified sed effects (in-place, file writes, execution or unsupported script)';
  }
  const cdPrefix = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&/.exec(command);
  if (cdPrefix) cwd = resolve(cwd, cdPrefix[1].replace(/^['"]|['"]$/g, ''));
  const canonical = target => {
    try { return realpathSync(target); }
    catch (error) { if (error.code !== 'ENOENT' || dirname(target) === target) throw error; return join(canonical(dirname(target)), basename(target)); }
  };
  const targetsWorkstream = (target, base = cwd) => {
    if (!target || /[$`*?~]/.test(target)) return true;
    try { return insideRoot(canonical(resolve(base, target)), canonical(resolve(root))); }
    catch { return true; }
  };
  // Output redirection writes authored files as well as logs; external scratch
  // redirection remains available. Prefer host background-task logs otherwise.
  for (const match of command.matchAll(/(?:^|[^>])>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g)) {
    const target = match[1].replace(/^['"]|['"]$/g, '');
    if (target === '&1' || target === '&2' || target === '/dev/null') continue;
    if (targetsWorkstream(target)) return 'project source authorship (redirection)';
  }
  let currentCwd = cwd;
  for (const segment of safeCommandSegments(command) ?? [command]) {
    const tokens = simpleTokens(segment);
    if (!tokens) {
      if (/(?:^|[\s;&|])(?:tee|cp|mv|rm|rmdir|mkdir|touch|ln|chmod|patch|sed|perl)\b/.test(segment)) return 'unresolved source-writing command';
      continue;
    }
    const index = commandIndex(tokens); const executable = executableName(tokens[index]); const args = tokens.slice(index + 1);
    if (executable === 'cd' && args.length === 1) { currentCwd = resolve(currentCwd, args[0]); continue; }
    if (executable === 'rm' && args.some(arg => ['/', '/tmp', '/private/tmp', '.', '..'].includes(arg))) return 'destructive root removal';
    if (executable === 'curl') {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-O' || args[i] === '--remote-name' || args[i].includes('%output{')) return 'project source authorship (HTTP output)';
        if (['-o', '--output'].includes(args[i]) && args[i + 1] !== '/dev/null' && targetsWorkstream(args[i + 1], currentCwd)) return 'project source authorship (HTTP output)';
      }
    }
    if (['tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'chmod', 'patch'].includes(executable) || ['sed', 'perl'].includes(executable) && args.some(arg => /^-[A-Za-z]*i/.test(arg))) {
      if (!args.length || args.filter(arg => !arg.startsWith('-')).some(target => targetsWorkstream(target, currentCwd))) return `project source authorship (${executable})`;
    }
    if (executable === 'git' && /\b(?:apply|checkout|restore|clean|reset)\b|\bstash\s+(?:pop|apply)\b/.test(args.join(' '))) return 'project source authorship (git worktree mutation)';
    if (executable === 'git' && args[0] === 'branch' && args.length > 1 && !args.slice(1).every(arg => ['--show-current', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose'].includes(arg))) return 'Git branch mutation requires delivery review';
  }
  return null;
}

function allowedSafeSegment(segment, config, root) {
  const control = parseControlCommand(segment) ?? parseControllerCommand(segment);
  if (control) return SAFE_COMPOSED_CONTROLS.has(control.kind);
  const tokens = simpleTokens(segment);
  if (!tokens) return false;
  const index = commandIndex(tokens);
  const executable = executableName(tokens[index]);
  if (executable === 'cd') return tokens.length === index + 2;
  if (executable === 'xargs') {
    const nested = tokens.slice(index + 1);
    return nested.length > 0 && !nested[0].startsWith('-') && allowedBashCommand(nested.join(' '), config, root);
  }
  return allowedBashCommand(segment, config, root);
}

function directOperationalDeliverySegment(segment) {
  const tokens = simpleTokens(segment);
  if (!tokens || !protectedSimpleCommand(tokens)) return false;
  const index = commandIndex(tokens);
  const executable = executableName(tokens[index]);
  return ['git', 'gh', 'command', 'env', 'exec'].includes(executable);
}

function allowedOperationalDelivery(command, config, root) {
  const segments = safeCommandSegments(command);
  return Boolean(segments?.every((segment) => directOperationalDeliverySegment(segment) || allowedSafeSegment(segment, config, root)));
}

function permittedExternalTarget(target, root, config) {
  if (typeof target !== 'string' || !isAbsolute(target) || /[`$\x00-\x1f]/.test(target) || insideRoot(target, root)) return false;
  // Resolve every existing ancestor, including a symlink at the final target.
  const canonical = (path) => {
    try { lstatSync(path); return realpathSync(path); }
    catch (error) { if (error.code !== 'ENOENT' || dirname(path) === path) throw error; return join(canonical(dirname(path)), basename(path)); }
  };
  let normalized;
  try { normalized = canonical(resolve(target)); if (insideRoot(normalized, canonical(resolve(root)))) return false; } catch { return false; }
  return (config?.guard?.externalWriteRoots ?? []).some((pattern) => {
    let absolutePattern;
    try { absolutePattern = pattern.includes('*') ? resolve(pattern) : canonical(resolve(pattern)); } catch { return false; }
    if (!absolutePattern.includes('*')) return insideRoot(normalized, absolutePattern);
    const escaped = absolutePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*');
    return new RegExp(`^${escaped}(?:/.*)?$`).test(normalized);
  });
}

function externalOnlyWriteCommand(command, root, config) {
  const lines = typeof command === 'string' ? command.split('\n') : [];
  const heredoc = /^\s*cat\s+<<'([A-Za-z][A-Za-z0-9_]{7,63})'\s*(>|>>)\s*("[^"]+"|'[^']+'|\/[^\s;]+)\s*$/.exec(lines[0] ?? '');
  if (heredoc) {
    const target = heredoc[3].replace(/^['"]|['"]$/g, '');
    return lines.at(-1) === heredoc[1] && permittedExternalTarget(target, root, config);
  }
  if (lines.length !== 1 || /[`$();|&<>]/.test(command.replace(/\s*(?:>|>>)\s*(?:"[^"]+"|'[^']+'|\/[^\s;]+)\s*$/, ''))) return false;
  const simple = /^\s*(?:cat|echo|printf)\b([^\n]*?)\s*(>|>>)\s*("[^"]+"|'[^']+'|\/[^\s;]+)\s*$/.exec(command);
  if (!simple || /[`$();|&<>]/.test(simple[1])) return false;
  return permittedExternalTarget(simple[3].replace(/^['"]|['"]$/g, ''), root, config);
}

function readOnlyMcpTool(toolName, config) {
  if (!toolName.startsWith('mcp__')) return false;
  const final = toolName.split('__').at(-1);
  // Read-like names alone do not establish effects (e.g. query_database).
  if (/(?:^|_)(?:write|create|delete|update|execute|run|publish|send|install|mutate)(?:_|$)/i.test(final)) return false;
  if (/^mcp__(?:mobbin|plugin_mobbin_mobbin)__(?:search_apps|search_screens|search_flows|search_sections|get_app|get_screen|get_flow|list_apps)$/.test(toolName)) return true;
  const patterns = config?.guard?.readOnlyMcpTools ?? ['mcp__context7__*', 'mcp__ide__getDiagnostics'];
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`).test(toolName);
  });
}

const deny = (reason) => ({ decision: 'deny', reason });
const defer = () => ({ decision: 'defer' });

function assignedTestCommand(command, root, cwd = root) {
  // No shell composition, environment changes, output files or rewrite flags.
  if (typeof command !== 'string' || /[;&|<>`$\n]/.test(command)) return false;
  const words = simpleTokens(command);
  if (!words || commandIndex(words) !== 0) return false;
  const [bin, ...args] = words;
  if (args.some(arg => /^(?:-u|--(?:update|update-snapshot|test-update-snapshots|write|fix|force))(?:=|$)/.test(arg))) return false;
  if (['npm', 'pnpm', 'yarn'].includes(bin)) {
    if (bin === 'npm' && (args[0] === '--prefix' || args[0]?.startsWith('--prefix='))) {
      const prefix = args[0] === '--prefix' ? (args.shift(), args.shift()) : args.shift().slice('--prefix='.length);
      if (!containedNpmPrefix(prefix, root, cwd)) return false;
    }
    if (args[0] === 'run') args.shift();
    if (!/^test(?::[\w:-]+)?$/.test(args.shift() ?? '')) return false;
    return args.every(arg => arg === '--' || /^--(?:test-concurrency|test-name-pattern|test-reporter)(?:=.+)?$/.test(arg) || /^[\w./*:-]+$/.test(arg) && !arg.startsWith('-'));
  }
  if (bin !== 'node' || args.shift() !== '--test') return false;
  return args.every(arg => /^--(?:test-concurrency|test-name-pattern|test-reporter)=.+$/.test(arg)
    || !arg.startsWith('-') && /^(?:tests?|specs?)\/[\w./*-]+\.(?:mjs|cjs|js|ts)$/.test(arg));
}

function allowedUnhealthyReads(command) {
  // Unhealthy state cannot authorize dev controls, remote reads or image
  // inspection. Reuse flag checks only after selecting plain local commands.
  const local = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'diff', 'stat', 'file', 'which', 'echo', 'printf', 'pwd', 'sed', 'git', 'du', 'ps', 'pgrep', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq']);
  const segments = safeCommandSegments(command);
  return Boolean(segments?.every(segment => {
    const tokens = simpleTokens(segment);
    return tokens && commandIndex(tokens) === 0 && local.has(executableName(tokens[0]))
      && !referencesImage(tokens) && !tokens.some(token => /^(?:https?|ftp|ssh):\/\//i.test(token))
      && allowedDiscussionReads(segment, null, process.cwd());
  }));
}

export function classifyUnhealthyToolUse({ toolName, toolInput, health }) {
  if (typeof toolName !== 'string' || !isPlainObject(toolInput)) return deny('malformed tool request');
  if (['Read', 'WebFetch'].includes(toolName) && referencesImage(toolInput)) return deny('Image inspection remains denied while state or executor identity cannot be trusted');
  if (modeSkillTarget(toolName, toolInput)) return deny('Activity skills are owner-only; use Modes commands instead of retired Fabex activity commands');
  if (health === 'migration-deferred' && ['Monitor', 'TaskOutput', 'ToolSearch', 'AskUserQuestion'].includes(toolName)) return defer();
  if (isPluginSkill(toolName, toolInput) || READ_TOOLS.has(toolName)) return defer();
  if (toolName === 'Bash') {
    const control = parseControlCommand(toolInput.command) ?? parseControllerCommand(toolInput.command);
    if (control && SAFE_UNHEALTHY.has(control.kind)) return defer();
    if (health === 'migration-deferred' && allowedUnhealthyReads(toolInput.command)) return defer();
  }
  return deny(`state is ${health}; only reads and exact diagnostic or recovery controls are available`);
}

export async function classifyToolUse({ toolName, toolInput, state, paths, executor = {}, config = null, env = process.env, invocationCwd = paths?.canonicalRoot }) {
  if (typeof toolName !== 'string' || !isPlainObject(toolInput) || !state || !paths) return deny('malformed tool request');
  // Apply the stricter activity before private lifecycle controls too; a stale
  // normal route must never authorize dev-start/cleanup after Modes changed.
  if (executor.sessionId && state.route !== 'recovery-read-only') {
    const permission = await activitySnapshot(paths.canonicalRoot, executor.sessionId, env);
    if (permission.active) {
      const route = permission.activity === 'work' ? 'normal' : permission.activity === 'ask' ? 'ask-once' : 'discussion';
      const participants = resolveSettings(config, state, executor.sessionId).values.participants;
      state = { ...state, route, participants, ownerSelectedMode: { route, participants, selectedAt: state.ownerSelectedMode?.selectedAt ?? new Date().toISOString() } };
    }
  }
  const profile = resolveSettings(config, state, executor.sessionId).values;
  const main = !executor.agentId && !executor.agentType;
  const bound = Boolean(executor.sessionId && executor.sessionId === state.workspace?.activeSessionId && state.workspace?.sessions[executor.sessionId]?.milestoneId === state.workspace?.activeMilestoneId);
  const task = executionPlan(config, state, executor.sessionId);
  const authorship = authorshipPolicy(profile, task);
  const documentTarget = isDocumentationTarget(writeTarget(toolInput), paths.canonicalRoot);
  const testTarget = isTestTarget(writeTarget(toolInput), paths.canonicalRoot);
  const claudeTestEdits = bound && main && authorship.testWriter === 'claude'
    && state.ownerSelectedMode?.route === 'normal' && !state.modeGrant?.pausedAt && !state.controller.activeOperationId;
  const testEdit = claudeTestEdits && testTarget;
  const claudeEdits = bound && main && authorship.coder === 'claude'
    && !(task.role === 'docs' && documentTarget && state.controller.activeOperationId);
  const claudeDocuments = bound && main && authorship.claudeDocuments
    && !state.controller.activeOperationId && state.ownerSelectedMode?.route === 'normal' && !state.modeGrant?.pausedAt;
  const documentEdit = claudeDocuments && documentTarget;
  const claudeImages = bound && main && ['claude', 'both'].includes(profile['roles.imageReview.executor']);
  if (toolName === 'Skill' && /^(?:fabex:)?(?:settings|milestone|session)$/.test(toolInput.skill ?? '') && (toolInput.args ?? '').trim()) return deny('settings changes require an owner-typed slash command');
  if (toolName.split('__')[0] === 'mcp' && toolName.split('__')[1] === 'codex') return deny('Codex turns must use the canonical Fabex SDK controller');
  if (modeSkillTarget(toolName, toolInput)) return deny('Activity skills are owner-only; use Modes commands instead of retired Fabex activity commands; invoke the slash command directly to mint a single-use grant');
  const structuralController = toolName === 'Bash' ? parseControllerCommand(toolInput.command) : null;
  const controller = toolName === 'Bash' ? parseControllerCommand(toolInput.command, { participants: state.participants }) : null;
  if (controller?.kind === 'controller-submit') {
    const envelope = normalizeSubmissionEnvelope(controller.message, state.participants);
    if (envelope.ownerSessionId && envelope.ownerSessionId !== executor.sessionId) return deny('ownerSessionId must match this host session');
    if (envelope.phase === 'reconcile' && state.operations.find(op => op.id === envelope.parentOperationId)?.result.relay?.sessionId !== executor.sessionId) return deny('reconciliation must belong to this host session');
  }
  const control = toolName === 'Bash' ? parseControlCommand(toolInput.command) : null;
  if (toolName === 'AskUserQuestion' && state.route === 'recovery-read-only') return main && matchesWorkspaceQuestion(state, executor.sessionId, toolInput.questions) ? defer() : deny('recovery settings dialog requires this session’s exact owner-issued questions');
  if (control?.kind === 'workspace-apply') {
    const grant = state.workspace?.grants[control.grantId];
    return main && grant && grant.sessionId === executor.sessionId && grant.expiresAt >= Date.now() && (state.route !== 'recovery-read-only' || grant.command === 'settings') ? defer() : deny('settings changes require this session\'s owner-issued grant');
  }
  if (control?.kind === 'workspace-view') return defer();
  const activeSession = executor.sessionId === state.workspace?.activeSessionId;
  if (controller?.kind === 'controller-continue') return main && state.route === 'normal' && state.operations.some(op => op.id === controller.operationId && op.result.relay?.sessionId === executor.sessionId && reviewSessionMatches(state, op)) ? defer() : deny('Continuation requires the originating main session in work mode.');
  if (control?.kind === 'task-role') return activeSession && main && state.route !== 'recovery-read-only' ? defer() : deny('task role selection requires the bound main session');
  if (control?.kind === 'usage-report') return activeSession ? defer() : deny('bind this session before reading its usage settings');
  if (control?.kind === 'milestone-checkpoint') return main && activeSession && state.route !== 'recovery-read-only' ? defer() : deny('milestone checkpoint requires the bound main session and healthy state');
  if (control?.kind === 'usage-snapshot') return main && activeSession ? defer() : deny('usage recording requires the bound main session');
  if (controller?.kind === 'controller-seal') {
    const op = state.operations.find(item => item.id === controller.operationId);
    return main && op?.result.relay?.sessionId === executor.sessionId && state.route !== 'recovery-read-only' ? defer() : deny('only the originating main session seals its independent assessment');
  }
  if (['mem', 'prompts', 'resources-list', 'heavy-status', 'heavy-wait'].includes(control?.kind)) return defer();
  if (['heavy-release', 'heavy-recover'].includes(control?.kind)) return state.route === 'normal' && state.ownerSelectedMode?.route === 'normal' && !state.modeGrant?.pausedAt && (!(executor.agentId || executor.agentType) || isOperationalExecutor(executor)) ? defer() : deny('heavy recovery requires owner-selected work mode and main or operational executor');
  if (control?.kind === 'resources-release' && (executor.agentId || executor.agentType) && !isOperationalExecutor(executor)) return deny('resource shutdown requires the main or verified operational executor');
  if (['resources-retain', 'resources-release', 'checkpoint-continuation'].includes(control?.kind)) return state.route === 'normal' && state.ownerSelectedMode?.route === 'normal' && !state.modeGrant?.pausedAt ? defer() : deny('resource and continuation changes require owner-selected work mode');
  if (control?.kind?.startsWith('dev-')) {
    const mutation = ['dev-start', 'dev-stop', 'dev-restart'].includes(control.kind);
    if (!['normal', 'discussion', 'ask-once'].includes(state.route)) return deny('dev controls require healthy work, discussion, or ask mode');
    if (mutation && (state.route !== 'normal' || state.ownerSelectedMode?.route !== 'normal' || state.modeGrant?.pausedAt || executor.agentId && !isOperationalExecutor(executor))) return deny('dev lifecycle requires owner-selected work mode and the main or verified operational executor, with no pending transition');
    return defer();
  }
  if (control?.kind === 'cleanup' && (state.route !== 'normal' || executor.agentId && !isOperationalExecutor(executor))) return deny('verified cleanup is restricted to the main or operational executor in work mode');
  if (control?.kind?.startsWith('mode-') && !modeGrantMatches(state.modeGrant, { id: control.grantId, sessionId: executor.sessionId ?? null, route: control.route, participants: control.participants })) return deny('mode changes require a matching unexpired grant minted by an owner-typed Fabex slash command');
  if (control?.kind?.startsWith('mode-')) {
    try {
      if (control.participants === 'claude' && control.attachments.length) return deny('Claude-only mode does not forward Codex attachments');
      validateAttachments(control.attachments, paths.canonicalRoot, config, { sessionId: state.modeGrant.sessionId, env });
      return defer();
    } catch (error) { return deny(`mode attachments failed validation: ${error.message}`); }
  }
  if (toolName === 'Bash' && structuralController?.kind === 'controller-submit' && !controller) return deny('both-participant submit requires an explicit valid Claude reply status');
  if (toolName === 'Bash' && (controller?.kind === 'controller-submit' || ['checkpoint-replace', 'checkpoint-snapshot'].includes(control?.kind))) {
    if (controller?.kind === 'controller-submit' && state.participants === 'claude') return deny('Claude-only mode denies Codex SDK turns; explicitly switch participants first');
    if (controller?.kind === 'controller-submit' && !state.ownerSelectedMode) return deny('prior owner-selected mode is unknown; type a Fabex mode command');
    if (controller?.kind === 'controller-submit') {
      let envelope, sessionId;
      try {
        envelope = normalizeSubmissionEnvelope(controller.message, state.participants);
        sessionId = await attachmentSessionId(paths.canonicalRoot, envelope, state, env);
        if (executor.sessionId && sessionId && executor.sessionId !== sessionId) return deny('upload session evidence does not match this host session');
      } catch (error) { return deny(`owner message resolution failed: ${error.message}`); }
      try {
        validateAttachments(envelope.attachments ?? [], paths.canonicalRoot, config, { sessionId, env });
      }
      catch (error) { return deny(`image attachments failed validation; no text-only fallback: ${error.message}`); }
    }
    if (state.route === 'recovery-read-only') return deny('recovery-read-only denies this command');
    return defer();
  }
  const protectedOperation = toolName === 'Bash' ? protectedGithubOperation(toolInput.command) : null;
  // Diagnostic only: never allow a composed control or scan an accepted heredoc body.
  if (toolName === 'Bash' && !control && safeCommandSegments(toolInput.command)?.some((segment) => parseControlCommand(segment)?.kind?.startsWith('mode-'))) {
    return deny('command shape is not an exact Fabex control; run the mode command standalone with no prefix, chain, or pipe');
  }
  if (!claudeImages && !isOperationalExecutor(executor) && ['Read', 'WebFetch'].includes(toolName) && referencesImage(toolInput)) return deny('Image inspection belongs to Codex by default, or the verified operational helper; Fable and other subagents must use their description');
  if (protectedOperation && (state.route !== 'normal' || state.ownerSelectedMode?.route !== 'normal' || state.modeGrant?.pausedAt || ((executor.agentId || executor.agentType) && !isOperationalExecutor(executor)))) {
    return deny(`${protectedOperation} requires owner-selected work mode and the main session or verified ${OPERATIONAL_AGENT} subagent`);
  }
  if (protectedOperation && !allowedOperationalDelivery(toolInput.command, config, paths.canonicalRoot)) return deny('Git delivery commands must be direct, parseable, and composed only with allowlisted read or delivery segments');
  if (toolName === 'Bash') {
    if (invokesFabexScript(toolInput.command, CONTROL_PATH) && !control && !allowedDiscussionReads(toolInput.command, config, paths.canonicalRoot)) return deny('only exact Fabex controls or composed read-only controls are allowed');
    if (invokesFabexScript(toolInput.command, CONTROLLER_PATH) && !controller) return deny('only exact Fabex controller entry points are allowed; seal/submit heredocs require a single-quoted delimiter of 8–64 characters, starting with a letter and containing only letters, digits or underscore, with a matching closing line');
    if (controller?.kind === 'controller-submit' && state.participants === 'claude') return deny('Claude-only mode denies Codex SDK turns; explicitly switch participants first');
    if (controller?.kind === 'controller-submit' && state.route === 'recovery-read-only') return deny('recovery-read-only denies new Codex SDK turns');
  }
  // Activity policy is owned by Modes; private Fabex controls above retain their
  // own authorization. Recovery, image roles and partner gates remain here.
  let activity = null;
  if (executor.sessionId && toolName === 'Bash' && state.route !== 'recovery-read-only') {
    const permission = await activitySnapshot(paths.canonicalRoot, executor.sessionId, env);
    const words = simpleTokens(toolInput.command);
    const trusted = [resolve(PLUGIN_ROOT, 'scripts/activity-control.mjs'), ...(permission.providerRoot ? [resolve(permission.providerRoot, 'scripts/control.mjs')] : [])];
    if (permission.installed && words?.[0] === 'node' && trusted.includes(words[1]) && words[3] === permission.root && words[4] === executor.sessionId) {
      if (words[2] === 'status' && words.length === 5 || words[2] === 'read' && words.length === 6) return defer();
      if (words[2] === 'write' && words.length === 6) {
        if (!bound || !main || state.modeGrant || state.operations.some(op => ['queued','working'].includes(op.status)) || deliveryObligations(await ownerDeliveries(paths.canonicalRoot, env), state, executor.sessionId).length) return deny('Contained writes require the bound main session and completed partner review.');
        try {
          writePlan(permission.root);
          const edits = decodeEdits(words[5]);
          if (edits.some(e => !e || !writableTarget(permission.root, e.path, e) || !researchAuthorAllowed(permission.root, e.path, authorship, 'claude'))) return deny('Research source and text retain their Coding, Test Writing and Documentation assignments.');
          return defer();
        } catch (e) { return deny(e.message); }
      }
      if (words[2] === 'run' && bound && main && task.executor === 'claude' && words.length >= 7 && !state.operations.some(op => ['queued','working'].includes(op.status)) && !deliveryObligations(await ownerDeliveries(paths.canonicalRoot, env), state, executor.sessionId).length) return defer();
    }
  }
  if (executor.sessionId && state.route !== 'recovery-read-only' && !control && !controller) {
    activity = await activityDecision(paths.canonicalRoot, executor.sessionId, toolName, toolInput, env,
      await ownsResearchHelper(paths.canonicalRoot, executor.sessionId, toolInput.recipient ?? toolInput.task_id, env));
    if (activity.decision === 'deny') return deny(activity.reason);
    if (activity.permission.installed && activity.permission.activity !== 'work') {
      const pending = deliveryObligations(await ownerDeliveries(paths.canonicalRoot, env), state, executor.sessionId);
      const independent = state.operations.some(op => op.result.relay?.sessionId === executor.sessionId && op.request.phase === 'independent' && !op.request.interrupted && (['queued','working'].includes(op.status) || op.status === 'completed' && !state.operations.some(child => child.request.parentOperationId === op.id && child.status === 'completed')));
      if (WRITE_TOOLS.has(toolName) && (!bound || !main || !researchAuthorAllowed(activity.permission.root, writeTarget(toolInput), authorship, 'claude'))) return deny('Research source and text retain their Coding, Test Writing and Documentation assignments.');
      if (WRITE_TOOLS.has(toolName) && (pending.length || independent)) return deny('Research edits wait for owner-message assessment and reconciliation.');
      if (toolName === 'Bash') {
        try {
          readPlan(activity.permission.root, toolInput.command);
          const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
          return { decision: 'defer', updatedInput: { ...toolInput, command: `node ${quote(resolve(PLUGIN_ROOT, 'scripts/activity-control.mjs'))} read ${quote(activity.permission.root)} ${quote(executor.sessionId)} ${quote(toolInput.command)}` } };
        } catch (e) { return deny(e.message); }
      }
      return defer();
    }
  }
  if (state.route === 'normal' || activity?.permission.installed && activity.permission.activity === 'work') {
    const pending = executor.sessionId ? deliveryObligations(await ownerDeliveries(paths.canonicalRoot, env), state, executor.sessionId) : [];
    const refresh = executor.sessionId ? await refreshState(paths.canonicalRoot, env) : null;
    const awaitingReceipt = refresh && ['prepared', 'awaiting-receipt'].includes(refresh.status);
    const independent = state.operations.some(op => op.result.relay?.sessionId === executor.sessionId && op.request.phase === 'independent' && !op.request.interrupted && (['queued', 'working'].includes(op.status) || op.status === 'completed' && !state.operations.some(child => child.request.parentOperationId === op.id && child.status === 'completed')));
    // Validation of already reconciled work is not new implementation. Keep the
    // exception tied to the assigned runner and armed work, with no code turn
    // writing concurrently. Ordinary writes and new builds remain gated.
    const checkpoint = state.partner.thread.checkpoint;
    const testValidation = toolName === 'Bash' && bound && main && authorship.testRunner === 'claude'
      && checkpoint.continuation.armed && checkpoint.openWork.length > 0 && !checkpoint.blocker && !checkpoint.ownerActionRequired
      && !awaitingReceipt && !state.modeGrant?.pausedAt
      && state.operations.some(op => op.request.phase === 'reconcile' && op.status === 'completed' && op.result.relay?.sessionId === executor.sessionId && !blockingReviewWarning(op))
      && !state.operations.some(op => op.status === 'working' && op.request.phase !== 'independent' && op.request.sandbox === 'workspace-write')
      && assignedTestCommand(toolInput.command, paths.canonicalRoot, invocationCwd);
    if ((pending.length || independent || awaitingReceipt) && (WRITE_TOOLS.has(toolName) || toolName === 'Bash' && !control && !controller && !testValidation && !allowedDiscussionReads(toolInput.command, config, paths.canonicalRoot) || toolName.startsWith('mcp__') && !readOnlyMcpTool(toolName, config))) return deny('Owner message assessment, reconciliation and any pending handoff receipt must finish before affected implementation. Continue the existing partner cycle.');
    if (protectedOperation) return defer();
    if (WRITE_TOOLS.has(toolName) && insideRoot(writeTarget(toolInput), paths.canonicalRoot) && !(claudeEdits && !testTarget) && !testEdit && !documentEdit && !activeExecutorException(state, toolName, executor)) {
      return deny('Application edits belong to Coding; recognized test files belong to Test Writing. Documentation permits text documents only. Ambiguous targets and helpers require their existing permissions');
    }
    if (WRITE_TOOLS.has(toolName)) return defer();
    if (READ_TOOLS.has(toolName) || isPluginSkill(toolName, toolInput)) return defer();
    if (toolName === 'Bash') {
      const exactControl = control ?? controller;
      if (exactControl) return defer();
      if (!state.ownerSelectedMode || state.ownerSelectedMode.route !== 'normal' || state.modeGrant?.pausedAt) return deny('routine development requires owner-selected work mode with no pending transition');
      const rule = workCommandDenial(toolInput.command, paths.canonicalRoot, invocationCwd, config);
      if (rule && !rule.startsWith('project source authorship')) return deny(`work policy: ${rule}`);
      if (activeExecutorException(state, toolName, executor)) return defer();
      if (bound && main && authorship.coder !== 'claude' && task.role === 'testWriting' && !allowedDiscussionReads(toolInput.command, config, paths.canonicalRoot)) return deny('Test Writing uses Write/Edit on recognized test files. Select Test Running for assigned execution; application-writing shell commands remain denied.');
      if (rule && !claudeEdits) return deny(`work policy: ${rule}; only the selected Coding AI authors project source`);
      return defer();
    }
    if (toolName.startsWith('mcp__')) {
      if (typeof toolInput.command === 'string') {
        if (protectedGithubOperation(toolInput.command)) return deny('Git delivery must use the verified operational Bash lane');
        const rule = workCommandDenial(toolInput.command, paths.canonicalRoot, invocationCwd, config);
        if (rule && !(claudeEdits && rule.startsWith('project source authorship'))) return deny(`work policy: ${rule}`);
      }
      if (/(?:^|_)(?:commit|push|publish|deploy|drop_database|reset_database)(?:_|$)/i.test(toolName.split('__').at(-1))) return deny('delivery, deployment or destructive MCP effects are not routine development');
      const target = writeTarget(toolInput);
      if (/(?:write|edit|create|delete|move|patch)/i.test(toolName.split('__').at(-1)) && (target || /(?:file|filesystem|apply_patch)/i.test(toolName)) && insideRoot(target, paths.canonicalRoot) && !(claudeEdits && (!testTarget || authorship.testWriter === 'claude')) && !documentEdit && !activeExecutorException(state, toolName, executor)) return deny('work policy: Coding owns application files; Test Writing owns recognized tests; ambiguous or mixed MCP targets are not authorized');
      return defer();
    }
    return defer();
  }
  if (!['discussion', 'ask-once', 'recovery-read-only'].includes(state.route)) return deny('invalid route; use recover');
  if (['discussion', 'ask-once'].includes(state.route)) {
    if (['SendMessage', 'TaskOutput'].includes(toolName)) return main && await ownsResearchHelper(paths.canonicalRoot, executor.sessionId, toolInput.recipient ?? toolInput.task_id, env) && (toolName !== 'SendMessage' || toolInput.type === 'message') ? defer() : deny('Research communication is limited to this session’s recorded helpers; no new authority is granted.');
    if (toolName === 'ToolSearch' || toolName === 'Skill') return defer(); // later actions remain guarded
    if (WRITE_TOOLS.has(toolName)) return permittedExternalTarget(writeTarget(toolInput), paths.canonicalRoot, config) ? defer() : deny('read-only route permits writes only in validated external scratch/memory roots');
    if (toolName === 'Bash' && (externalOnlyWriteCommand(toolInput.command, paths.canonicalRoot, config) || allowedDiscussionReads(toolInput.command, config, paths.canonicalRoot))) return defer();
    if (toolName === 'WebSearch' && typeof toolInput.query === 'string' && toolInput.query.trim()) return defer();
    if (toolName === 'WebFetch') {
      try { const url = new URL(toolInput.url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return defer(); } catch {}
      return deny('read-only research requires an HTTP(S) URL without embedded credentials');
    }
    if (['Agent', 'Task'].includes(toolName)) return defer();
    if (toolName.startsWith('mcp__') && readOnlyMcpTool(toolName, config)) return defer();
  }
  if (isPluginSkill(toolName, toolInput) || READ_TOOLS.has(toolName)) return defer();
  if (WRITE_TOOLS.has(toolName)) return deny(`${state.route} is read-only`);
  if (toolName === 'Bash') {
    const control = parseControlCommand(toolInput.command) ?? parseControllerCommand(toolInput.command);
    if (control) {
      if (state.route !== 'recovery-read-only' || SAFE_UNHEALTHY.has(control.kind)) return defer();
      return deny('recovery-read-only permits only diagnostic and recovery controls');
    }
    return deny(`${state.route} requires read-only effects; command contains an unsupported or mutating segment`);
  }
  return deny(`${state.route} denies tools outside the read-only allowlist`);
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('hook input is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function main() {
  let output;
  try {
    const input = await readInput();
    const root = await rootFromHookInput(input, process.env);
    let activityFailure = null;
    try { await observeActivity(root, input, process.env); } catch (e) { activityFailure = e; }
    const stateResult = await readState(root, process.env);
    const effective = stateResult.ok ? await loadEffectiveConfig(stateResult.paths.canonicalRoot, process.env) : null;
    output = activityFailure
      ? classifyUnhealthyToolUse({ toolName:input.tool_name, toolInput:input.tool_input, health:'activity-permission-unavailable' })
      : stateResult.ok
      ? await classifyToolUse({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        state: stateResult.state,
        paths: stateResult.paths,
        executor: { agentId: input.agent_id, agentType: input.agent_type, sessionId: input.session_id },
        config: effective.config,
        invocationCwd: input.cwd
      })
      : classifyUnhealthyToolUse({ toolName: input.tool_name, toolInput: input.tool_input, health: stateResult.health });
    if (output.decision !== 'deny' && stateResult.ok && input.tool_name === 'AskUserQuestion') await recordWorkspaceQuestion(root, input);
    if (!activityFailure && output.decision !== 'deny' && stateResult.ok && stateResult.state.route === 'normal' && input.tool_name === 'Bash' && heavyShape(input.tool_input?.command)) {
      const id = input.tool_use_id ? `host:${input.session_id ?? ''}:${input.tool_use_id}` : '';
      const admission = await beginHeavy(root, { id, command: input.tool_input.command, executor: input.agent_type ?? 'claude-main', wrapperRequested: true, cwd: input.cwd ?? root });
      if (!admission.allowed) output = deny(admission.reason);
      else { output.updatedInput = wrappedHeavyInput(input.tool_input, id, CONTROL_PATH); if (admission.warning) output.warning = admission.warning; }
    }
  } catch {
    output = deny('route guard input or internal failure; use diagnose and recover');
  }
  process.stdout.write(output.decision === 'deny'
    ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: output.reason } })}\n`
    : output.warning || output.updatedInput ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...(output.warning ? { additionalContext: output.warning } : {}), ...(output.updatedInput ? { updatedInput: output.updatedInput } : {}) } })}\n` : '{}\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
