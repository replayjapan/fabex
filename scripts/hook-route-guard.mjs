#!/usr/bin/env node
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT, rootFromHookInput } from './lib/paths.mjs';
import { loadEffectiveConfig } from './lib/config.mjs';
import { readState } from './lib/state.mjs';
import { isPlainObject, UUID_RE } from './lib/validation.mjs';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SKILL_TOOLS = new Set(['Skill', 'SlashCommand']);
const BARE_SKILLS = new Set(['ask', 'askClaude', 'askCodex', 'discussion', 'discussionClaude', 'discussionCodex', 'work', 'workClaude', 'status', 'diagnose', 'recover']);
const CONTROL_PATH = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
const CONTROLLER_PATH = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
const SAFE_UNHEALTHY = new Set(['status', 'config', 'diagnose', 'controller-status', 'controller-result', 'controller-cancel', 'controller-wait', 'clear-dead-lock', 'recover-inspect', 'recover-abandon', 'recover-replace-missing-thread', 'recover-resolve-transaction']);
const OPERATIONAL_AGENT = 'fabex-operational';
// Plugin-defined agents are reported by the hook harness with their plugin-scoped type.
// Reject the bare agent name so an identity outside that contract cannot gain push authority.
const OPERATIONAL_AGENT_TYPE = 'fabex:fabex-operational';
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
      else {
        if (quote === '"' && ['$', '`', '\\'].includes(char)) return null;
        current += char;
        started = true;
      }
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined || /[\r\n]/.test(next)) return null;
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
  if (['status', 'config', 'diagnose'].includes(args[0]) && args.length === 1) return { kind: args[0] };
  if (args[0] === 'checkpoint' && ['capacity', 'export'].includes(args[1]) && args.length === 2) return { kind: `checkpoint-${args[1]}` };
  const fields = new Set(['objective', 'current-task', 'constraint', 'decision', 'relevant-file', 'implementation-status', 'test-status', 'unresolved-problem', 'next-action']);
  if (args[0] === 'checkpoint' && fields.has(args[1]) && typeof args[2] === 'string' && args[2].length > 0 && Buffer.byteLength(args[2], 'utf8') <= 8192 && args.length === 3) return { kind: 'checkpoint' };
  if (args[0] === 'checkpoint' && args[1] === 'compact' && ['constraint', 'decision', 'relevant-file', 'unresolved-problem'].includes(args[2]) && args[3] === '--keep-last' && /^\d+$/.test(args[4] ?? '') && args.length === 5) return { kind: 'checkpoint-compact' };
  if (args[0] === 'executor-exception' && args[1] === 'authorize' && args.length === 8 && args[2] === '--executor' && args[4] === '--scope' && args[6] === '--reason' && args[3] && args[5] && args[7]) return { kind: 'executor-exception-authorize' };
  if (args[0] === 'executor-exception' && args[1] === 'reconcile' && args.length === 4 && args[2] === '--outcome' && args[3]) return { kind: 'executor-exception-reconcile' };
  if (args[0] === 'mode' && ['normal', 'discussion', 'ask-once'].includes(args[1])) {
    if (args.length === 2) return { kind: `mode-${args[1]}`, participants: 'both' };
    if (args.length === 4 && args[2] === '--participants' && ['both', 'claude', 'codex'].includes(args[3])) return { kind: `mode-${args[1]}`, participants: args[3] };
  }
  if (args[0] === 'recover' && args[1] === 'clear-dead-lock' && args.length === 2) return { kind: 'clear-dead-lock' };
  if (args[0] === 'recover' && args[1] === 'resolve-transaction' && args.length === 3 && ['--commit', '--discard'].includes(args[2])) return { kind: 'recover-resolve-transaction' };
  if (args[0] === 'recover' && ['inspect', 'abandon', 'replace-missing-thread'].includes(args[1]) && args.length === 4 && args[2] === '--operation-id' && UUID_RE.test(args[3])) return { kind: `recover-${args[1]}` };
  return null;
}

export function parseControllerCommand(command) {
  if (typeof command === 'string' && command.includes('\n')) {
    const lines = command.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const header = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+submit\s+<<'([A-Za-z][A-Za-z0-9_]{7,63})'$/.exec(lines[0] ?? '');
    if (header && resolve(header[1] ?? header[2] ?? header[3]) === CONTROLLER_PATH && lines.at(-1) === header[4]) {
      const message = lines.slice(1, -1).join('\n');
      if (message.trim() && Buffer.byteLength(message, 'utf8') <= 192 * 1024) return { kind: 'controller-submit' };
    }
  }
  const tokens = simpleTokens(command);
  if (!tokens || basename(tokens[0] ?? '') !== 'node' || resolve(tokens[1] ?? '') !== CONTROLLER_PATH) return null;
  const args = tokens.slice(2);
  if (args[0] === 'submit' && args.length === 3 && args[1] === '--message' && typeof args[2] === 'string' && args[2].length > 0 && Buffer.byteLength(args[2], 'utf8') <= 192 * 1024) return { kind: 'controller-submit' };
  if (['status', 'result', 'cancel'].includes(args[0]) && args.length === 3 && args[1] === '--operation-id' && UUID_RE.test(args[2])) return { kind: `controller-${args[0]}` };
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

function allowedBashCommand(command, config) {
  const tokens = simpleTokens(command);
  if (!tokens) return false;
  const index = commandIndex(tokens);
  const executable = executableName(tokens[index]);
  const args = tokens.slice(index + 1);
  const extras = new Set((config?.guard?.allowedCommands ?? []).map((value) => executableName(value)));
  if (extras.has(executable)) return true;
  if (executable === 'sed') return args.includes('-n') && !args.some((arg) => arg === '-i' || arg.startsWith('-i'));
  if (executable === 'env') return args.length === 0;
  if (executable === 'find') return !args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg));
  if (BASE_READ_COMMANDS.has(executable)) return true;
  if (executable === 'node') return args.length === 1 && args[0] === '--version' || args[0] === '--test';
  if (['pnpm', 'npm', 'yarn'].includes(executable)) return ['test', 'lint', 'build', 'typecheck'].includes(args[0]) && !args.some((arg) => ['--write', '--fix', '--update', '-u'].includes(arg));
  if (executable === 'npx') return ['vitest', 'jest', 'tsc'].includes(executableName(args[0])) && !args.some((arg) => ['--write', '--fix', '--update', '-u'].includes(arg));
  if (executable === 'git') {
    let cursor = index + 1;
    while (tokens[cursor]?.startsWith('-')) cursor += GIT_OPTIONS_WITH_VALUES.has(tokens[cursor]) ? 2 : 1;
    const subcommand = tokens[cursor];
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
      if (command[index + 1] === undefined || /[\r\n]/.test(command[index + 1])) return null;
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

function allowedComposedBashCommand(command, config) {
  const segments = safeCommandSegments(command);
  if (!segments) return false;
  return segments.every((segment) => {
    const tokens = simpleTokens(segment);
    if (tokens && executableName(tokens[commandIndex(tokens)]) === 'cd') return tokens.length === commandIndex(tokens) + 2;
    return allowedBashCommand(segment, config);
  });
}

function externalOnlyWriteCommand(command, root) {
  const lines = typeof command === 'string' ? command.split('\n') : [];
  const heredoc = /^\s*cat\s+<<'([A-Za-z][A-Za-z0-9_]{7,63})'\s*>\s*("[^"]+"|'[^']+'|\/[^\s;]+)\s*$/.exec(lines[0] ?? '')
    ?? /^\s*cat\s*>\s*("[^"]+"|'[^']+'|\/[^\s;]+)\s*<<'([A-Za-z][A-Za-z0-9_]{7,63})'\s*$/.exec(lines[0] ?? '');
  if (heredoc) {
    const delimiterFirst = lines[0].includes("<<'") && lines[0].indexOf("<<'") < lines[0].indexOf('>');
    const delimiter = delimiterFirst ? heredoc[1] : heredoc[2];
    const target = (delimiterFirst ? heredoc[2] : heredoc[1]).replace(/^['"]|['"]$/g, '');
    return lines.at(-1) === delimiter && isAbsolute(target) && !insideRoot(target, root);
  }
  if (typeof command !== 'string' || /(?:^|[^>])>>(?!>)/.test(command)) return false;
  const targets = [...command.matchAll(/(?:^|[^>])>\s*("[^"]+"|'[^']+'|\/[^\s\n;]+)/g)].map((match) => match[1].replace(/^['"]|['"]$/g, ''));
  if (targets.length !== 1 || !isAbsolute(targets[0]) || insideRoot(targets[0], root)) return false;
  return /^\s*(?:cat|echo|printf)\b/.test(command) && !/[;&|`$()]/.test(command.replace(/<<'[^']+'/g, ''));
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
  if (isPluginSkill(toolName, toolInput) || READ_TOOLS.has(toolName)) return defer();
  if (toolName === 'Bash') {
    const control = parseControlCommand(toolInput.command) ?? parseControllerCommand(toolInput.command);
    if (control && SAFE_UNHEALTHY.has(control.kind)) return defer();
  }
  return deny(`state is ${health}; only reads and exact diagnostic or recovery controls are available`);
}

export async function classifyToolUse({ toolName, toolInput, state, paths, executor = {}, config = null }) {
  if (typeof toolName !== 'string' || !isPlainObject(toolInput) || !state || !paths) return deny('malformed tool request');
  const protectedOperation = toolName === 'Bash' ? protectedGithubOperation(toolInput.command) : null;
  if (protectedOperation && !isOperationalExecutor(executor)) {
    return deny(`${protectedOperation} requires a verified ${OPERATIONAL_AGENT} subagent; main-session, alternate-agent, and ambiguous executor identities are denied`);
  }
  if (toolName === 'Bash') {
    const controller = parseControllerCommand(toolInput.command);
    if (invokesFabexScript(toolInput.command, CONTROLLER_PATH) && !controller) return deny('only exact Fabex controller submit, status, result, cancel, and wait entry points are allowed');
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
      const control = parseControlCommand(toolInput.command) ?? parseControllerCommand(toolInput.command);
      if (control) return defer();
      if (activeExecutorException(state, toolName, executor)) return defer();
      if (allowedBashCommand(toolInput.command, config) || allowedComposedBashCommand(toolInput.command, config) || externalOnlyWriteCommand(toolInput.command, paths.canonicalRoot)) return defer();
      return deny('normal Fabex mode permits Bash only through the read/verification allowlist, exact Fabex controls, or writes whose only target is an absolute path outside the workstream root');
    }
    if (toolName.startsWith('mcp__')) return readOnlyMcpTool(toolName, config) || activeExecutorException(state, toolName, executor) ? defer() : deny('normal Fabex mode permits only allowlisted read-only MCP tools');
    return defer();
  }
  if (!['discussion', 'ask-once', 'recovery-read-only'].includes(state.route)) return deny('invalid route; use recover');
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
        executor: { agentId: input.agent_id, agentType: input.agent_type },
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
