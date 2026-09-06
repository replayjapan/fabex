import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { dataRoot, PLUGIN_ROOT } from './paths.mjs';
import { isPlainObject } from './validation.mjs';

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULTS_FILE = resolve(PLUGIN_ROOT, 'config', 'defaults.json');
export const PROJECT_CONFIG_RELATIVE_PATH = '.fabex/config.json';
export const CODEX_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KEYS = {
  '': new Set(['schemaVersion', 'models', 'collaboration', 'display', 'project', 'guard']),
  models: new Set(['claudePrimary', 'codex', 'operational']),
  'models.codex': new Set(['model', 'reasoningEffort', 'networkAccessEnabled']),
  collaboration: new Set(['jointByDefault']),
  display: new Set(['replyModeBadge']),
  project: new Set(['repositoryRoot']),
  guard: new Set(['allowedCommands', 'allowedCommandPatterns', 'externalWriteRoots', 'readOnlyMcpTools'])
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const nonEmptyToken = (value) => typeof value === 'string' && TOKEN_RE.test(value.trim());

function warnUnknown(value, path, warnings) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!KEYS[path].has(key)) warnings.push(`unknown config key ${path ? `${path}.` : ''}${key} was ignored`);
  }
}

const exactExecutableArray = (value) => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(item.trim()));
const commandPatternArray = (value) => Array.isArray(value) && value.length <= 64 && value.every((item) => isPlainObject(item)
  && Object.keys(item).sort().join(',') === 'args,executable'
  && typeof item.executable === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(item.executable.trim())
  && Array.isArray(item.args) && item.args.length <= 32
  && item.args.every((arg) => typeof arg === 'string' && Buffer.byteLength(arg, 'utf8') <= 512 && (arg === '*' || !/[\0\r\n]/.test(arg))));
const externalRootArray = (value) => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string'
  && Buffer.byteLength(item, 'utf8') <= 4096 && (item.startsWith('~/') || isAbsolute(item)) && !normalize(item).split(/[\\/]/).includes('..'));
const toolPatternArray = (value) => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'string' && /^mcp__[A-Za-z0-9_*.-]+(?:__[A-Za-z0-9_*.-]+)+$/.test(item.trim()));
const relativeRepositoryRoot = (value) => typeof value === 'string' && value.trim() && !isAbsolute(value.trim()) && !normalize(value.trim()).split(/[\\/]/).includes('..');

function mergeLayer(base, overlay, warnings, name, { projectLayer = false } = {}) {
  const result = clone(base);
  if (!isPlainObject(overlay)) {
    warnings.push(`${name} config must be a JSON object; the entire layer was ignored`);
    return result;
  }
  const schemaVersion = 'schemaVersion' in overlay ? overlay.schemaVersion : 1;
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    warnings.push(`${name} config declares unsupported schemaVersion ${JSON.stringify(schemaVersion)}; the entire layer was ignored`);
    return result;
  }
  warnUnknown(overlay, '', warnings);
  if ('schemaVersion' in overlay) result.schemaVersion = overlay.schemaVersion;
  if ('models' in overlay) {
    if (!isPlainObject(overlay.models)) warnings.push('models must be an object; using lower-precedence model values');
    else {
      warnUnknown(overlay.models, 'models', warnings);
      if ('claudePrimary' in overlay.models) warnings.push('models.claudePrimary was removed and was ignored; choose the main Claude model with /model');
      if ('operational' in overlay.models) {
        if (nonEmptyToken(overlay.models.operational)) result.models.operational = overlay.models.operational.trim();
        else warnings.push('models.operational must be a non-empty model token; using the lower-precedence value');
      }
      if ('codex' in overlay.models) {
        if (!isPlainObject(overlay.models.codex)) warnings.push('models.codex must be an object; using lower-precedence Codex values');
        else {
          warnUnknown(overlay.models.codex, 'models.codex', warnings);
          if ('model' in overlay.models.codex) {
            const model = overlay.models.codex.model;
            if (model === null || nonEmptyToken(model)) result.models.codex.model = model === null ? null : model.trim();
            else warnings.push('models.codex.model must be null or a model token; using the lower-precedence value');
          }
          if ('reasoningEffort' in overlay.models.codex) {
            const effort = overlay.models.codex.reasoningEffort;
            if (nonEmptyToken(effort)) {
              result.models.codex.reasoningEffort = effort.trim();
              if (!CODEX_REASONING_EFFORTS.has(effort.trim())) warnings.push(`models.codex.reasoningEffort ${JSON.stringify(effort.trim())} is unknown and was passed through`);
            } else warnings.push('models.codex.reasoningEffort must be a non-empty token; using the lower-precedence value');
          }
          if ('networkAccessEnabled' in overlay.models.codex) {
            if (overlay.models.codex.networkAccessEnabled === true && !projectLayer && name !== 'shipped') warnings.push(`models.codex.networkAccessEnabled is project-layer only when enabled; ${name} value was ignored`);
            else if (typeof overlay.models.codex.networkAccessEnabled === 'boolean') result.models.codex.networkAccessEnabled = overlay.models.codex.networkAccessEnabled;
            else warnings.push('models.codex.networkAccessEnabled must be boolean; using the lower-precedence value');
          }
        }
      }
    }
  }
  if ('collaboration' in overlay) {
    if (!isPlainObject(overlay.collaboration)) warnings.push('collaboration must be an object; using the lower-precedence collaboration value');
    else {
      warnUnknown(overlay.collaboration, 'collaboration', warnings);
      if ('jointByDefault' in overlay.collaboration) {
        if (typeof overlay.collaboration.jointByDefault === 'boolean') result.collaboration.jointByDefault = overlay.collaboration.jointByDefault;
        else warnings.push('collaboration.jointByDefault must be boolean; using the lower-precedence value');
      }
    }
  }
  if ('display' in overlay) {
    if (!isPlainObject(overlay.display)) warnings.push('display must be an object; using the lower-precedence display value');
    else {
      warnUnknown(overlay.display, 'display', warnings);
      if ('replyModeBadge' in overlay.display) {
        if (['always', 'changes', 'off'].includes(overlay.display.replyModeBadge)) result.display.replyModeBadge = overlay.display.replyModeBadge;
        else warnings.push('display.replyModeBadge must be always, changes, or off; using the lower-precedence value');
      }
    }
  }
  if ('project' in overlay) {
    if (!projectLayer && name !== 'shipped') warnings.push(`project settings are project-layer only; ${name} project settings were ignored`);
    else if (!isPlainObject(overlay.project)) warnings.push('project must be an object; using lower-precedence project values');
    else {
      warnUnknown(overlay.project, 'project', warnings);
      if ('repositoryRoot' in overlay.project) {
        const value = overlay.project.repositoryRoot;
        if (value === null || relativeRepositoryRoot(value)) result.project.repositoryRoot = value === null ? null : normalize(value.trim());
        else warnings.push('project.repositoryRoot must be null or a relative path inside the workstream root; using the lower-precedence value');
      }
    }
  }
  if ('guard' in overlay) {
    if (!isPlainObject(overlay.guard)) warnings.push('guard must be an object; using lower-precedence guard values');
    else {
      warnUnknown(overlay.guard, 'guard', warnings);
      for (const key of ['allowedCommands', 'allowedCommandPatterns', 'externalWriteRoots', 'readOnlyMcpTools']) {
        if (!(key in overlay.guard)) continue;
        const valid = key === 'allowedCommands' ? exactExecutableArray(overlay.guard[key])
          : key === 'allowedCommandPatterns' ? commandPatternArray(overlay.guard[key])
            : key === 'externalWriteRoots' ? externalRootArray(overlay.guard[key]) : toolPatternArray(overlay.guard[key]);
        if (valid && key === 'allowedCommandPatterns') result.guard[key] = overlay.guard[key].map((item) => ({ executable: item.executable.trim(), args: [...item.args] }));
        else if (valid) result.guard[key] = overlay.guard[key].map((item) => item.trim());
        else warnings.push(`guard.${key} must be an array of bounded command or tool patterns; using the lower-precedence value`);
      }
    }
  }
  return result;
}

async function readOptional(file, name, warnings) {
  try {
    return { loaded: true, value: JSON.parse(await readFile(file, 'utf8')) };
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push(`could not load ${name} config: ${error.message}; the layer was ignored`);
    return { loaded: false, value: null };
  }
}

export async function loadEffectiveConfig(root, env = process.env) {
  const defaults = JSON.parse(await readFile(DEFAULTS_FILE, 'utf8'));
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
  defaults.guard.externalWriteRoots = [join(claudeConfigDir, 'projects', '*', 'memory'), '/private/tmp/claude-*/*/*/scratchpad', tmpdir()];
  const machineFile = resolve(dataRoot(env), 'config.json');
  const projectFile = resolve(root, PROJECT_CONFIG_RELATIVE_PATH);
  const warnings = [];
  const machine = await readOptional(machineFile, 'machine', warnings);
  const project = await readOptional(projectFile, 'project', warnings);
  let config = mergeLayer(defaults, {}, warnings, 'shipped');
  if (machine.loaded) config = mergeLayer(config, machine.value, warnings, 'machine');
  if (project.loaded) config = mergeLayer(config, project.value, warnings, 'project', { projectLayer: true });
  config.guard.externalWriteRoots = config.guard.externalWriteRoots.map((value) => value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : normalize(value));
  for (const executable of config.guard.allowedCommands) warnings.push(`guard.allowedCommands grants every invocation of ${executable}; prefer allowedCommandPatterns`);
  return {
    config,
    sources: {
      shipped: DEFAULTS_FILE,
      shippedLoaded: true,
      machine: machineFile,
      machineLoaded: machine.loaded,
      project: projectFile,
      projectLoaded: project.loaded
    },
    warnings
  };
}

export async function sourceVersion() {
  try { return JSON.parse(await readFile(resolve(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? 'unknown'; }
  catch { return 'unknown'; }
}

export function codexModelArgs(config) {
  const args = [];
  if (config.models.codex.model) args.push('--model', config.models.codex.model);
  if (config.models.codex.reasoningEffort) args.push('--effort', config.models.codex.reasoningEffort);
  return args;
}
