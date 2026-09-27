import { createRequire } from 'node:module';
import { dirname, join, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changePrivate } from './private-store.mjs';
import { heavyStatus, releaseHeavy } from './heavy.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

export function globalHelperNames(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const trimmed = line.trim(); if (trimmed.startsWith('#')) continue;
    // Narrow, explicit support for standard server tables, not a guessed TOML
    // parser. Unsupported forms fail only this opt-in setting.
    if (trimmed.includes('"""') || trimmed.includes("'''")) throw new Error('Helper-off requires standard MCP table configuration; multiline TOML is not supported by this reader.');
    if (/^mcp_servers\s*=/.test(trimmed) || /^\[\s*mcp_servers\s*\]/.test(trimmed)) throw new Error('Helper-off requires named MCP tables, not inline maps.');
    if (!/^\[\s*mcp_servers\s*\./.test(trimmed)) continue;
    const match = /^\[\s*mcp_servers\s*\.\s*(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')(?:\.[^\]]+)?\s*\]\s*(?:#.*)?$/.exec(trimmed);
    if (!match) throw new Error('Unsupported global MCP table name; no silent helper-server fallback.');
    names.add(match[1] ?? match[2] ?? match[3]);
  }
  return names;
}

export async function helperServerOptions(options, context, list = promisify(execFile), readConfig = readFile) {
  if (context.helperServers !== 'off') return options;
  const binary = options.env?.FABEX_SDK_BINARY;
  if (!binary) throw new Error('Cannot disable inherited MCP helpers: pinned CLI unavailable; no silent fallback.');
  let servers;
  try {
    const { stdout } = await list(binary, ['mcp', 'list', '--json'], { cwd: context.root, env: options.env, timeout: 5000, maxBuffer: 1024 * 1024 });
    servers = JSON.parse(stdout);
  } catch { throw new Error('MCP helper enumeration failed; no silent fallback. Private catalog output omitted.'); }
  if (!Array.isArray(servers) || servers.some(s => typeof s.name !== 'string' || typeof s.enabled !== 'boolean')) throw new Error('Unsupported MCP catalog; no silent helper-server fallback.');
  let text = '';
  try { text = await readConfig(join(options.env?.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read global MCP configuration; no silent fallback.'); }
  const names = globalHelperNames(text);
  const selected = servers.filter(s => names.has(s.name) && s.enabled);
  // Host/plugin-provided entries are not global server tables. Overriding their
  // names creates an invalid transport table; they remain host controlled.
  return { ...options, fabexHelperServers: { requested: 'off', scope: 'user config.toml MCP tables', configuredDisabled: selected.length, otherEnabled: servers.filter(s => s.enabled && !names.has(s.name)).length, verified: false },
    configOverrides: [...(options.configOverrides ?? []), ...selected.map(s => `mcp_servers.${s.name}.enabled=false`)] };
}

// Resolve the pinned SDK dependency, never an unrelated `codex` from PATH.
// Supports the two package layouts shipped by that dependency. Unknown layouts
// retain the normal SDK launcher and leave interrupted ownership unknown.
export function sdkLaunchOptions(options, { root, operationId, env = process.env }, resolveSdk = () => import.meta.resolve('@openai/codex-sdk')) {
  try {
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
    const suffix = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'linux' ? 'unknown-linux-musl' : null;
    if (!arch || !suffix) return options;
    const sdkRequire = createRequire(resolveSdk());
    const req = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
    const platform = req.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const base = join(dirname(platform), 'vendor', `${arch}-${suffix}`);
    const modern = existsSync(join(base, 'codex-package.json')) && existsSync(join(base, 'bin', 'codex'));
    const binary = join(base, modern ? 'bin' : 'codex', 'codex');
    if (!existsSync(binary)) return options;
    const tools = join(base, modern ? 'codex-path' : 'path');
    return { ...options, codexPathOverride: fileURLToPath(new URL('../sdk-process.mjs', import.meta.url)), env: {
      ...env, ...(existsSync(tools) ? { PATH: `${tools}${delimiter}${env.PATH ?? ''}` } : {}),
      FABEX_SDK_BINARY: binary, FABEX_SDK_ROOT: root, FABEX_SDK_OPERATION: operationId
    } };
  } catch { return options; }
}
export async function recordSdkProcess(root, operationId, identity, env = process.env) {
  return changePrivate(root, 'heavy-jobs.json', { jobs: [], samples: [] }, data => {
    data.sdkProcesses = [...(data.sdkProcesses ?? []).filter(item => item.operationId !== operationId), { operationId, identity }].slice(-16);
    for (const job of data.jobs) if (job.id.startsWith(`sdk:${operationId}:`) && !job.identity) job.identity = identity;
  }, env);
}
export async function recoverSdkJobs(root, operationId, env = process.env, dependencies = {}) {
  const outcomes = [];
  for (const job of (await heavyStatus(root, env)).jobs.filter(item => item.id.startsWith(`sdk:${operationId}:`))) {
    try { outcomes.push({ id: job.id, released: await releaseHeavy(root, job.id, env, dependencies) }); }
    catch { outcomes.push({ id: job.id, released: false }); }
  }
  return outcomes;
}
