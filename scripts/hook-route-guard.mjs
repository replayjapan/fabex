#!/usr/bin/env node
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

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SKILL_TOOLS = new Set(['Skill', 'SlashCommand']);
const BARE_SKILLS = new Set(['ask', 'askClaude', 'askCodex', 'discussion', 'discussionClaude', 'discussionCodex', 'work', 'workClaude', 'status', 'diagnose', 'recover']);
const CONTROL_PATH = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
const CONTROLLER_PATH = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
const SAFE_UNHEALTHY = new Set(['help', 'checkpoint-help', 'status', 'config', 'diagnose', 'controller-help', 'controller-status', 'controller-result', 'controller-cancel', 'controller-wait', 'clear-dead-lock', 'recover-inspect', 'recover-abandon', 'recover-replace-missing-thread', 'recover-resolve-transaction', 'mode-normal', 'mode-discussion', 'mode-ask-once']);
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

function commandReferencesImage(command) {
  // Inspect shell-resolved literal tokens too: quote concatenation must not
  // disguise an extension (for example screen.pn'g'). Unknown shell syntax is
  // still subject to the existing fail-closed command allowlist below.
  return (safeCommandSegments(command) ?? []).some((segment) => referencesImage(simpleTokens(segment) ?? []));
}

function readOnlyDelegation(input, paths, config, context) {
  const keys = new Set(['subagent_type', 'model', 'prompt', 'description', 'max_turns', 'run_in_background']);
  if (Object.keys(input).some((key) => !keys.has(key)) || typeof input.prompt !== 'string' || !input.prompt.trim()) return false;
  if (input.subagent_type === 'claude-code-guide') return true;
  if (input.subagent_type !== OPERATIONAL_AGENT_TYPE || input.model !== config?.models?.operational) return false;
  const prefix = 'FABEX IMAGE DESCRIPTION ONLY\n';
  if (typeof input.prompt !== 'string' || !input.prompt.startsWith(prefix)) return false;
  try {
    const payload = JSON.parse(input.prompt.slice(prefix.length));
    if (!isPlainObject(payload) || Object.keys(payload).join(',') !== 'attachments' || !Array.isArray(payload.attachments) || payload.attachments.length === 0) return false;
    validateAttachments(payload.attachments, paths.canonicalRoot, config, context);
    return true;
  } catch { return false; }
}
const GIT_OPTIONS_WITH_VALUES = new Set(['-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);

function simpleTokens(command) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) return null;
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) { quote = null; started = true; }
      else if (quote === '"' && char === '\\') {
        const next = command[index + 1];
        if (next === undefined) return null;
        if (/\r|\n/.test(next)) { index += 1; continue; }
        // These are the only characters for which a backslash has quoting
        // meaning inside double quotes. They remain literal argv content.
        if (['"', '\\', '$', '`'].includes(next)) current += next;
        else current += `\\${next}`;
        started = true;
        index += 1;
      } else {
        if (quote === '"' && ['$', '`'].includes(char)) return null;
        current += char;
        started = true;
      }
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;
      if (/[\r\n]/.test(next)) { index += 1; continue; }
      current += next;
      started = true;
      index += 1;
    } else if (/\s/.test(char)) {
      if (/[\r\n]/.test(char)) return null;
      if (started) { tokens.push(current); current = ''; started = false; }
    } else {
      if (/[;&|<>`$()*?\[\]{}~#]/.test(char)) return null;
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

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
  if (executable === 'gh') return 'GitHub CLI operation';
  if (executable === 'git') return protectedGitOperation(tokens, index);
  if (['bash', 'dash', 'fish', 'sh', 'zsh'].includes(executable)) {
    const commandIndex = tokens.indexOf('-c', index + 1);
    if (commandIndex !== -1 && typeof tokens[commandIndex + 1] === 'string') return protectedGithubOperation(tokens[commandIndex + 1]);
  }
  if (['command', 'env', 'exec', 'nohup', 'sudo', 'xcrun'].includes(executable)) {
    for (let candidate = index + 1; candidate < tokens.length; candidate += 1) {
      const nested = executableName(tokens[candidate]);
      if (nested === 'gh') return 'GitHub CLI operation';
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
    const header = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+checkpoint\s+(replace\s+(constraint|decision|relevant-file|unresolved-problem)|snapshot)\s+<<'([A-Za-z][A-Za-z0-9_]{7,63})'$/.exec(lines[0] ?? '');
    if (header && resolve(header[1] ?? header[2] ?? header[3]) === CONTROL_PATH && lines.at(-1) === header[6]) {
      const body = lines.slice(1, -1).join('\n');
      if (Buffer.byteLength(body, 'utf8') <= 48 * 1024) return { kind: header[4] === 'snapshot' ? 'checkpoint-snapshot' : 'checkpoint-replace' };
    }
  }
  const tokens = simpleTokens(command);
  if (!tokens || basename(tokens[0] ?? '') !== 'node' || resolve(tokens[1] ?? '') !== CONTROL_PATH) return null;
  const args = tokens.slice(2);
  if (args.length === 0 || args.length === 1 && args[0] === '--help') return { kind: 'help' };
  if (args[0] === 'status' && (args.length === 1 || args.length === 2 && ['--all', '--brief'].includes(args[1]))) return { kind: 'status' };
  if (['config', 'diagnose'].includes(args[0]) && args.length === 1) return { kind: args[0] };
  if (args[0] === 'cleanup' && args.length === 3 && args[1] === '--path' && isAbsolute(args[2]) && /^fabex-next(?:-\d+\.\d+\.\d+)?$/.test(basename(args[2]))) return { kind: 'cleanup' };
  if (args[0] === 'checkpoint' && (args.length === 1 || args.length === 2 && args[1] === '--help')) return { kind: 'checkpoint-help' };
  if (args[0] === 'checkpoint' && ['capacity', 'export'].includes(args[1]) && args.length === 2) return { kind: `checkpoint-${args[1]}` };
  const fields = new Set(['objective', 'current-task', 'constraint', 'decision', 'relevant-file', 'implementation-status', 'test-status', 'unresolved-problem', 'next-action']);
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
  if (args.length === 1 && args[0] === '--help') return { kind: 'controller-help' };
  if (args[0] === 'submit' && args.length === 3 && args[1] === '--message' && typeof args[2] === 'string' && args[2].length > 0 && Buffer.byteLength(args[2], 'utf8') <= 192 * 1024) return acceptedSubmit(args[2]);
  if (['status', 'result', 'relay', 'cancel'].includes(args[0]) && args.length === 3 && args[1] === '--operation-id' && UUID_RE.test(args[2])) return { kind: `controller-${args[0]}` };
  if (args[0] === 'wait' && args.length === 5 && args[1] === '--operation-id' && UUID_RE.test(args[2]) && args[3] === '--timeout' && /^\d+$/.test(args[4]) && Number(args[4]) >= 1 && Number(args[4]) <= 590) return { kind: 'controller-wait' };
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
  return modeTargetForSkill(toolName === 'Skill' ? input.skill : input.command);
}

function executorNames(executor) {
  if (!(typeof executor?.agentId === 'string' && executor.agentId.trim())) return new Set(['claude', 'claude-main', 'main-session']);
  return new Set([executor.agentId, executor.agentType].filter(Boolean).map((value) => value.toLowerCase()));
}

function activeExecutorException(state, toolName, executor) {
  const active = state.executorException;
  if (!active || !executorNames(executor).has(active.executor.toLowerCase())) return false;
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
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'remote', 'ls-files', 'stash']);

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

function readOnlyTagArgs(args) {
  return ['--list', '-l'].includes(args[0]) && (args.length === 1 || args.length === 2 && !args[1].startsWith('-'));
}

function allowedBashCommand(command, config, root) {
  const tokens = simpleTokens(command);
  if (!tokens) return false;
  const index = commandIndex(tokens);
  const executable = executableName(tokens[index]);
  const args = tokens.slice(index + 1);
  if (executable === 'du') return args[0] === '-sh' && args.slice(1).every((arg) => !arg.startsWith('-'));
  if (executable === 'ps') return args.length === 2 && args[0] === '-axo' && /^(?:pid|ppid|rss|etime|stat|comm)(?:,(?:pid|ppid|rss|etime|stat|comm))*$/.test(args[1]);
  const extras = new Set((config?.guard?.allowedCommands ?? []).map((value) => executableName(value)));
  if (extras.has(executable)) return true;
  if (commandPatternMatches(tokens, config, root)) return true;
  if (executable === 'sed') return args.includes('-n') && !args.some((arg) => arg === '-i' || arg.startsWith('-i'));
  if (executable === 'env') return args.length === 0;
  if (executable === 'find') return !args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg));
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
  if (executable === 'git') {
    let cursor = index + 1;
    while (tokens[cursor]?.startsWith('-')) cursor += GIT_OPTIONS_WITH_VALUES.has(tokens[cursor]) ? 2 : 1;
    const subcommand = tokens[cursor];
    if (subcommand === 'tag') return readOnlyTagArgs(tokens.slice(cursor + 1));
    if (!GIT_READ.has(subcommand)) return false;
    const gitArgs = tokens.slice(cursor + 1);
    if (gitArgs.some((arg) => arg === '--output' || arg.startsWith('--output='))) return false;
    if (subcommand === 'branch') return gitArgs.length === 0 || gitArgs.every((arg) => ['--show-current', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose'].includes(arg));
    if (subcommand === 'remote') return gitArgs.length === 1 && gitArgs[0] === '-v';
    if (subcommand === 'stash') return gitArgs.length === 1 && gitArgs[0] === 'list';
    return true;
  }
  return false;
}

function allowedRedirectionAt(command, index, literal) {
  if (!command.startsWith(literal, index)) return false;
  const before = command[index - 1];
  const after = command[index + literal.length];
  const boundaryBefore = before === undefined || /\s/.test(before);
  const boundaryAfter = after === undefined || /\s/.test(after) || ['|', ';', '&'].includes(after);
  return boundaryBefore && boundaryAfter;
}

function safeCommandSegments(command) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) return null;
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && command[index + 1] !== undefined) {
        current += command[index + 1];
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;
      if (/[\r\n]/.test(next)) {
        // A shell line continuation is whitespace within one logical command,
        // not a command boundary. Raw newlines remain denied below.
        current += ' ';
        index += 1;
        continue;
      }
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(') || (char === '<' && command[index + 1] === '(')) return null;
    const redirection = ['2>/dev/null', '2>&1'].find((literal) => allowedRedirectionAt(command, index, literal));
    if (redirection) {
      current += ' ';
      index += redirection.length - 1;
      continue;
    }
    if (char === '>' || char === '<' || char === '&' && command[index + 1] !== '&') return null;
    const separatorLength = char === '&' && command[index + 1] === '&' ? 2 : ['|', ';'].includes(char) ? 1 : 0;
    if (separatorLength) {
      if (char === '|' && command[index + 1] === '|') return null;
      const segment = current.trim();
      if (!segment) return null;
      segments.push(segment);
      current = '';
      index += separatorLength - 1;
      continue;
    }
    if (/[\r\n]/.test(char)) return null;
    current += char;
  }
  if (quote || !current.trim()) return null;
  segments.push(current.trim());
  return segments;
}

const SAFE_COMPOSED_CONTROLS = new Set(['status', 'config', 'diagnose', 'checkpoint-capacity', 'checkpoint-export', 'help', 'checkpoint-help', 'controller-status', 'controller-result', 'controller-wait', 'controller-help']);
SAFE_COMPOSED_CONTROLS.add('controller-relay');
SAFE_UNHEALTHY.add('controller-relay');

function allowedDiscussionReads(command, config, root) {
  const segments = safeCommandSegments(command);
  return Boolean(segments?.every((segment) => {
    const control = parseControlCommand(segment) ?? parseControllerCommand(segment);
    if (control) return SAFE_COMPOSED_CONTROLS.has(control.kind);
    const tokens = simpleTokens(segment);
    if (!tokens) return false;
    const executable = executableName(tokens[commandIndex(tokens)]);
    if (!BASE_READ_COMMANDS.has(executable) && !['sed', 'find', 'git', 'du', 'ps', 'pwd'].includes(executable)) return false;
    return allowedBashCommand(segment, { ...config, guard: { ...config?.guard, allowedCommands: [], allowedCommandPatterns: [] } }, root);
  }));
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

function allowedComposedBashCommand(command, config, root) {
  const segments = safeCommandSegments(command);
  if (!segments) return false;
  return segments.every((segment) => allowedSafeSegment(segment, config, root));
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
  if (/^(?:get_|list_|search_|read_|query_|view_|resolve_)/.test(final)) return true;
  const patterns = config?.guard?.readOnlyMcpTools ?? ['mcp__context7__*', 'mcp__ide__getDiagnostics'];
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`).test(toolName);
  });
}

const deny = (reason) => ({ decision: 'deny', reason });
const defer = () => ({ decision: 'defer' });

export function classifyUnhealthyToolUse({ toolName, toolInput, health }) {
  if (typeof toolName !== 'string' || !isPlainObject(toolInput)) return deny('malformed tool request');
  if (referencesImage(toolInput) || toolName === 'Bash' && commandReferencesImage(toolInput.command)) return deny('Image inspection remains denied while state or executor identity cannot be trusted');
  if (modeSkillTarget(toolName, toolInput)) return deny('Fabex mode skills are owner-only');
  if (health === 'migration-deferred' && ['Monitor', 'TaskOutput', 'ToolSearch', 'AskUserQuestion'].includes(toolName)) return defer();
  if (isPluginSkill(toolName, toolInput) || READ_TOOLS.has(toolName)) return defer();
  if (toolName === 'Bash') {
    const control = parseControlCommand(toolInput.command) ?? parseControllerCommand(toolInput.command);
    if (control && SAFE_UNHEALTHY.has(control.kind)) return defer();
  }
  return deny(`state is ${health}; only reads and exact diagnostic or recovery controls are available`);
}

export async function classifyToolUse({ toolName, toolInput, state, paths, executor = {}, config = null, env = process.env }) {
  if (typeof toolName !== 'string' || !isPlainObject(toolInput) || !state || !paths) return deny('malformed tool request');
  if (modeSkillTarget(toolName, toolInput)) return deny('Fabex mode skills are owner-only; invoke the slash command directly to mint a single-use grant');
  const structuralController = toolName === 'Bash' ? parseControllerCommand(toolInput.command) : null;
  const controller = toolName === 'Bash' ? parseControllerCommand(toolInput.command, { participants: state.participants }) : null;
  const control = toolName === 'Bash' ? parseControlCommand(toolInput.command) : null;
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
      try {
        const envelope = normalizeSubmissionEnvelope(controller.message, state.participants);
        const sessionId = await attachmentSessionId(paths.canonicalRoot, envelope, state, env);
        if (executor.sessionId && sessionId && executor.sessionId !== sessionId) return deny('upload session evidence does not match this host session');
        validateAttachments(envelope.attachments ?? [], paths.canonicalRoot, config, { sessionId, env });
      }
      catch (error) { return deny(`image attachments failed validation; no text-only fallback: ${error.message}`); }
    }
    if (state.route === 'recovery-read-only') return deny('recovery-read-only denies this command');
    return defer();
  }
  const protectedOperation = toolName === 'Bash' ? protectedGithubOperation(toolInput.command) : null;
  if (!isOperationalExecutor(executor) && (['Read', 'Bash', 'WebFetch'].includes(toolName) || toolName.startsWith('mcp__')) && (referencesImage(toolInput) || toolName === 'Bash' && commandReferencesImage(toolInput.command))) return deny('Image inspection belongs to Codex by default, or the verified operational helper; Fable and other subagents must use their description');
  if (protectedOperation && !isOperationalExecutor(executor)) {
    return deny(`${protectedOperation} requires a verified ${OPERATIONAL_AGENT} subagent; main-session, alternate-agent, and ambiguous executor identities are denied`);
  }
  if (protectedOperation && !allowedOperationalDelivery(toolInput.command, config, paths.canonicalRoot)) return deny('Git delivery commands must be direct, parseable, and composed only with allowlisted read or delivery segments');
  if (toolName === 'Bash') {
    if (invokesFabexScript(toolInput.command, CONTROLLER_PATH) && !controller) return deny('only exact Fabex controller submit, status, result, cancel, wait, and help entry points are allowed');
    if (controller?.kind === 'controller-submit' && state.participants === 'claude') return deny('Claude-only mode denies Codex SDK turns; explicitly switch participants first');
    if (controller?.kind === 'controller-submit' && state.route === 'recovery-read-only') return deny('recovery-read-only denies new Codex SDK turns');
  }
  if (state.route === 'normal') {
    if (isOperationalExecutor(executor) && protectedOperation) return defer();
    if (WRITE_TOOLS.has(toolName) && insideRoot(writeTarget(toolInput), paths.canonicalRoot) && !activeExecutorException(state, toolName, executor)) {
      return deny('normal Fabex mode reserves workstream edits for Codex; every Claude executor requires a structured owner-named exception');
    }
    if (WRITE_TOOLS.has(toolName)) return defer();
    if (READ_TOOLS.has(toolName) || isPluginSkill(toolName, toolInput)) return defer();
    if (toolName === 'Bash') {
      const exactControl = control ?? controller;
      if (exactControl) return defer();
      if (activeExecutorException(state, toolName, executor)) return defer();
      if (allowedBashCommand(toolInput.command, config, paths.canonicalRoot) || allowedComposedBashCommand(toolInput.command, config, paths.canonicalRoot) || externalOnlyWriteCommand(toolInput.command, paths.canonicalRoot, config)) return defer();
      return deny('normal Fabex mode permits Bash only through the read/verification allowlist, exact Fabex controls, or writes whose only target is an absolute path outside the workstream root');
    }
    if (toolName.startsWith('mcp__')) return readOnlyMcpTool(toolName, config) || activeExecutorException(state, toolName, executor) ? defer() : deny('normal Fabex mode permits only allowlisted read-only MCP tools');
    return defer();
  }
  if (!['discussion', 'ask-once', 'recovery-read-only'].includes(state.route)) return deny('invalid route; use recover');
  if (['discussion', 'ask-once'].includes(state.route)) {
    if (WRITE_TOOLS.has(toolName)) return permittedExternalTarget(writeTarget(toolInput), paths.canonicalRoot, config) ? defer() : deny('read-only route permits writes only in validated external scratch/memory roots');
    if (toolName === 'Bash' && (externalOnlyWriteCommand(toolInput.command, paths.canonicalRoot, config) || allowedDiscussionReads(toolInput.command, config, paths.canonicalRoot))) return defer();
    if (toolName === 'WebSearch' && typeof toolInput.query === 'string' && toolInput.query.trim()) return defer();
    if (toolName === 'WebFetch') {
      try { const url = new URL(toolInput.url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return defer(); } catch {}
      return deny('read-only research requires an HTTP(S) URL without embedded credentials');
    }
    if (['Agent', 'Task'].includes(toolName)) return readOnlyDelegation(toolInput, paths, config, { env, sessionId: state.contextEvidence.ownerPrompt?.sessionId === executor.sessionId ? executor.sessionId : '' }) ? defer() : deny('read-only delegation permits claude-code-guide or the configured operational model with the exact image-description envelope only');
  }
  if (isPluginSkill(toolName, toolInput) || READ_TOOLS.has(toolName)) return defer();
  if (WRITE_TOOLS.has(toolName)) return deny(`${state.route} is read-only`);
  if (toolName === 'Bash') {
    const control = parseControlCommand(toolInput.command) ?? parseControllerCommand(toolInput.command);
    if (control) {
      if (state.route !== 'recovery-read-only' || SAFE_UNHEALTHY.has(control.kind)) return defer();
      return deny('recovery-read-only permits only diagnostic and recovery controls');
    }
    return deny(`${state.route} permits only exact Fabex controls and SDK controller entry points`);
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
    const stateResult = await readState(root, process.env);
    const effective = stateResult.ok ? await loadEffectiveConfig(stateResult.paths.canonicalRoot, process.env) : null;
    output = stateResult.ok
      ? await classifyToolUse({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        state: stateResult.state,
        paths: stateResult.paths,
        executor: { agentId: input.agent_id, agentType: input.agent_type, sessionId: input.session_id },
        config: effective.config
      })
      : classifyUnhealthyToolUse({ toolName: input.tool_name, toolInput: input.tool_input, health: stateResult.health });
  } catch {
    output = deny('route guard input or internal failure; use diagnose and recover');
  }
  process.stdout.write(output.decision === 'deny'
    ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: output.reason } })}\n`
    : '{}\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
