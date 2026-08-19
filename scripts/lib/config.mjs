import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataRoot, PLUGIN_ROOT } from './paths.mjs';
import { isPlainObject } from './validation.mjs';

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULTS_FILE = resolve(PLUGIN_ROOT, 'config', 'defaults.json');
export const PROJECT_CONFIG_RELATIVE_PATH = '.fabex/config.json';
export const CODEX_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const KEYS = {
  '': new Set(['schemaVersion', 'models', 'collaboration']),
  models: new Set(['claudePrimary', 'codex', 'operational']),
  'models.codex': new Set(['model', 'reasoningEffort']),
  collaboration: new Set(['jointByDefault'])
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const nonEmptyToken = (value) => typeof value === 'string' && TOKEN_RE.test(value.trim());

function warnUnknown(value, path, warnings) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!KEYS[path].has(key)) warnings.push(`unknown config key ${path ? `${path}.` : ''}${key} was ignored`);
  }
}

function mergeLayer(base, overlay, warnings, name) {
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
  const machineFile = resolve(dataRoot(env), 'config.json');
  const projectFile = resolve(root, PROJECT_CONFIG_RELATIVE_PATH);
  const warnings = [];
  const machine = await readOptional(machineFile, 'machine', warnings);
  const project = await readOptional(projectFile, 'project', warnings);
  let config = mergeLayer(defaults, {}, warnings, 'shipped');
  if (machine.loaded) config = mergeLayer(config, machine.value, warnings, 'machine');
  if (project.loaded) config = mergeLayer(config, project.value, warnings, 'project');
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

export function codexModelArgs(config) {
  const args = [];
  if (config.models.codex.model) args.push('--model', config.models.codex.model);
  if (config.models.codex.reasoningEffort) args.push('--effort', config.models.codex.reasoningEffort);
  return args;
}
