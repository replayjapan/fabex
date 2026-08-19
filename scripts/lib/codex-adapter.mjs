import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readState, updateState } from './state.mjs';

const COMPANION_NAMES = new Set(['codex', 'openai-codex']);
async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function searchCache(root, depth = 0) {
  if (depth > 5 || !(await exists(root))) return null;
  const metadataFile = join(root, '.claude-plugin', 'plugin.json');
  if (await exists(metadataFile)) {
    try {
      const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
      if (COMPANION_NAMES.has(String(metadata.name).toLowerCase())) return root;
    } catch {}
  }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await searchCache(join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

export async function discoverCompanionRuntime(env = process.env) {
  if (env.FABEX_CODEX_PLUGIN_ROOT && await exists(env.FABEX_CODEX_PLUGIN_ROOT)) return env.FABEX_CODEX_PLUGIN_ROOT;
  for (const root of [join(homedir(), '.claude', 'plugins', 'cache'), join(homedir(), '.claude', 'plugins', 'marketplaces')]) {
    const found = await searchCache(root);
    if (found) return found;
  }
  return null;
}

async function mutate(root, purpose, fn, env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner state unavailable: ${current.health}`);
  const updated = await updateState(root, (state) => {
    fn(state);
    state.generation += 1;
    return state;
  }, { expectedGeneration: current.state.generation, purpose }, env);
  if (!updated.ok) throw new Error(`partner state update failed safely: ${updated.health}`);
  return updated.state;
}

export async function beginPartnerOperation(root, { envelope, name = 'joint-opening' }, env = process.env) {
  const current = await readState(root, env);
  if (!current.ok) throw new Error(`partner operation denied: ${current.health}`);
  const id = randomUUID();
  await mutate(root, 'partner-intent', (state) => {
    state.partner.status = 'running';
    state.partner.envelope = { ...envelope };
    state.operations.push({ id, kind: 'partner', name, status: 'running', externalId: null });
  }, env);
  return { operationId: id, envelope };
}

export async function completePartnerOperation(root, operationId, { threadId, decisionId = randomUUID() }, env = process.env) {
  return mutate(root, 'partner-completed', (state) => {
    const operation = state.operations.find((item) => item.id === operationId && item.kind === 'partner');
    if (!operation) throw new Error('partner operation is not recorded');
    operation.status = 'completed';
    operation.externalId = threadId;
    state.partner.status = 'completed';
    state.partner.threadId = threadId;
    state.task.joint.status = 'completed';
    state.task.joint.decisionId = decisionId;
  }, env);
}
