import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function canonicalizeRoot(root) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('project root is required');
  return realpath(resolve(root));
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function pathsForCanonicalRoot(canonicalRoot, env) {
  const projectId = projectIdFor(canonicalRoot);
  const projectDir = join(dataRoot(env), 'projects', projectId);
  return {
    canonicalRoot,
    projectId,
    dataDir: dataRoot(env),
    projectDir,
    stateFile: join(projectDir, 'state.json'),
    transactionFile: join(projectDir, 'transaction.json'),
    lockDir: join(projectDir, 'lock'),
    lockOwnerFile: join(projectDir, 'lock', 'owner.json')
  };
}

async function hasFabexState(canonicalRoot, env) {
  const paths = pathsForCanonicalRoot(canonicalRoot, env);
  return await exists(paths.stateFile) || await exists(paths.transactionFile) || await exists(paths.lockDir);
}

export async function resolveWorkstreamRoot(start, env = process.env) {
  let candidate = await canonicalizeRoot(start);
  const invokedRoot = candidate;
  let owningAncestor = null;
  while (true) {
    if (await hasFabexState(candidate, env)) owningAncestor = candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return owningAncestor ?? invokedRoot;
    candidate = parent;
  }
}

export async function rootFromHookInput(input, env = process.env) {
  if (!input || typeof input.cwd !== 'string' || input.cwd.length === 0) throw new Error('hook payload cwd is required');
  return resolveWorkstreamRoot(input.cwd, env);
}

export async function rootFromControlCwd(cwd = process.cwd(), env = process.env) {
  return resolveWorkstreamRoot(cwd, env);
}

export function projectIdFor(canonicalRoot) {
  return createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
}

export function dataRoot(env = process.env) {
  if (env.FABEX_HOME) return isAbsolute(env.FABEX_HOME) ? resolve(env.FABEX_HOME) : resolve(homedir(), env.FABEX_HOME);
  return join(homedir(), '.claude', 'plugins', 'data', 'fabex');
}

export async function projectPaths(root, env = process.env) {
  const canonicalRoot = await canonicalizeRoot(root);
  return pathsForCanonicalRoot(canonicalRoot, env);
}
