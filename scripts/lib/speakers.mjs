import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function modelFamily(model) {
  if (typeof model !== 'string') return null;
  const slug = model.replace(/\[[^\]]*\]$/u, '').split('/').at(-1);
  if (/^(?:fable|opus|sonnet|haiku)$/i.test(slug)) return slug[0].toUpperCase() + slug.slice(1).toLowerCase();
  const family = /^(?:claude-|gpt-\d+(?:\.\d+)?-)([a-z]+)(?:-|$)/i.exec(slug)?.[1];
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : null;
}

export function speakerLabels(claudeModel, codexModel, claudeSource = null) {
  const label = (speaker, model) => `${speaker}${modelFamily(model) ? ` (${modelFamily(model)})` : ''}:`;
  const family = modelFamily(claudeModel) ?? claudeModel;
  return { claude: `Claude (${family || 'model unknown'})${claudeSource === 'Claude settings default' ? ' [configured]' : ''}:`, codex: label('Codex', codexModel) };
}

export async function claudeModelSource(record, env = process.env) {
  const clean = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,128}(?:\[[A-Za-z0-9]+\])?$/.test(value)
    ? value.replace(/\[[^\]]*\]$/u, '') : null;
  const observed = clean(record?.id);
  if (observed) return { id: observed, source: 'session hook evidence', verified: false };
  try {
    const settings = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8'));
    const id = clean(settings.model);
    if (id) return { id, source: 'Claude settings default', verified: false };
  } catch {}
  return { id: null, source: 'unknown', verified: false };
}

export async function codexModelSource(config, env = process.env) {
  if (config.models.codex.model) return { id: config.models.codex.model, source: 'Fabex config', verified: false };
  try {
    const text = await readFile(join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8');
    const top = text.split(/^\s*\[/m)[0];
    if (/^\s*profile\s*=/m.test(top)) return { id: null, source: 'unknown', verified: false };
    const match = /^\s*model\s*=\s*["']([A-Za-z0-9._:/-]{1,128})["']\s*(?:#.*)?$/m.exec(top);
    if (match) return { id: match[1], source: 'Codex config default', verified: false };
  } catch {}
  return { id: null, source: 'unknown', verified: false };
}
