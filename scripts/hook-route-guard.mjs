#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT, rootFromHookInput } from './lib/paths.mjs';
import { readState } from './lib/state.mjs';
import { isPlainObject, UUID_RE } from './lib/validation.mjs';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SKILL_TOOLS = new Set(['Skill', 'SlashCommand']);
const BARE_SKILLS = new Set(['ask', 'askClaude', 'askCodex', 'discussion', 'discussionClaude', 'discussionCodex', 'work', 'workClaude', 'status', 'diagnose', 'recover']);
const CONTROL_PATH = resolve(PLUGIN_ROOT, 'scripts', 'control.mjs');
const CONTROLLER_PATH = resolve(PLUGIN_ROOT, 'scripts', 'controller.mjs');
const SAFE_UNHEALTHY = new Set(['status', 'config', 'diagnose', 'controller-status', 'controller-result', 'controller-cancel', 'clear-dead-lock', 'recover-inspect', 'recover-abandon', 'recover-replace-missing-thread', 'recover-resolve-transaction']);
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
  if (['push', 'send-pack'].includes(subcommand)) return 'git push operation';
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
  const git = new RegExp(`${boundary}${wrappers}${path}git(?:\\.exe)?\\s+[^;&|()\\r\\n]{0,512}\\b(?:push|send-pack|lfs\\s+push)${commandEnd}`, 'i');
  if (git.test(command)) return 'ambiguous or composed git push operation';
  return null;
}

function isOperationalExecutor(executor) {
  return typeof executor?.agentId === 'string'
    && executor.agentId.trim().length > 0
    && executor.agentType === OPERATIONAL_AGENT_TYPE;
}

export function parseControlCommand(command) {
  const tokens = simpleTokens(command);
  if (!tokens || basename(tokens[0] ?? '') !== 'node' || resolve(tokens[1] ?? '') !== CONTROL_PATH) return null;
  const args = tokens.slice(2);
  if (['status', 'config', 'diagnose'].includes(args[0]) && args.length === 1) return { kind: args[0] };
  const fields = new Set(['objective', 'current-task', 'constraint', 'decision', 'relevant-file', 'implementation-status', 'test-status', 'unresolved-problem', 'next-action']);
  if (args[0] === 'checkpoint' && fields.has(args[1]) && typeof args[2] === 'string' && args[2].length > 0 && Buffer.byteLength(args[2], 'utf8') <= 8192 && args.length === 3) return { kind: 'checkpoint' };
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
  return null;
}

function invokesFabexScript(command, path) {
  const tokens = simpleTokens(command);
  if (tokens && basename(tokens[0] ?? '') === 'node' && resolve(tokens[1] ?? '') === path) return true;
  return typeof command === 'string' && command.includes('controller.mjs');
}

function isPluginSkill(toolName, input) {
  if (!SKILL_TOOLS.has(toolName)) return false;
  const invocation = toolName === 'Skill' ? input.skill : input.command;
  if (typeof invocation !== 'string') return false;
  const name = invocation.replace(/^\//, '');
  return name.startsWith('fabex:') || BARE_SKILLS.has(name);
}

function mainSession(executor) {
  return !(typeof executor?.agentId === 'string' && executor.agentId.trim().length > 0);
}

function activeMainEditException(state, toolName) {
  const decisions = state.partner.thread.checkpoint.acceptedDecisions;
  const allowedExecutors = new Set(['claude', 'claude-main', 'main-session']);
  let active = null;
  for (const decision of decisions) {
    const authorized = /^Executor exception authorized: executor=([^;]+); scope=([^;]+); reason=.+$/i.exec(decision);
    if (authorized && allowedExecutors.has(authorized[1].trim().toLowerCase())) active = { executor: authorized[1].trim().toLowerCase(), scope: authorized[2].trim().toLowerCase() };
    const reconciled = /^Executor exception reconciled: executor=([^;]+); scope=([^;]+); outcome=.+$/i.exec(decision);
    if (reconciled && active && reconciled[1].trim().toLowerCase() === active.executor && reconciled[2].trim().toLowerCase() === active.scope) active = null;
  }
  if (!active) return false;
  return ['project file edits', 'all edits', toolName.toLowerCase()].includes(active.scope);
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

export async function classifyToolUse({ toolName, toolInput, state, paths, executor = {} }) {
  if (typeof toolName !== 'string' || !isPlainObject(toolInput) || !state || !paths) return deny('malformed tool request');
  const protectedOperation = toolName === 'Bash' ? protectedGithubOperation(toolInput.command) : null;
  if (protectedOperation && !isOperationalExecutor(executor)) {
    return deny(`${protectedOperation} requires a verified ${OPERATIONAL_AGENT} subagent; main-session, alternate-agent, and ambiguous executor identities are denied`);
  }
  if (toolName === 'Bash') {
    const controller = parseControllerCommand(toolInput.command);
    if (invokesFabexScript(toolInput.command, CONTROLLER_PATH) && !controller) return deny('only exact Fabex controller submit, status, result, and cancel entry points are allowed');
    if (controller?.kind === 'controller-submit' && state.participants === 'claude') return deny('Claude-only mode denies Codex SDK turns; explicitly switch participants first');
    if (controller?.kind === 'controller-submit' && state.route === 'recovery-read-only') return deny('recovery-read-only denies new Codex SDK turns');
  }
  if (state.route === 'normal') {
    if (WRITE_TOOLS.has(toolName) && mainSession(executor) && !activeMainEditException(state, toolName)) {
      return deny('normal Fabex mode reserves project edits for Codex; Claude main-session Write/Edit/NotebookEdit requires an owner-named recorded executor exception');
    }
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
    output = stateResult.ok
      ? await classifyToolUse({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        state: stateResult.state,
        paths: stateResult.paths,
        executor: { agentId: input.agent_id, agentType: input.agent_type }
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
