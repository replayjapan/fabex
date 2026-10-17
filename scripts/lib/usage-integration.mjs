import { resolveRepositoryDirectory } from './sdk-controller.mjs';
import { readPrivate, changePrivate, sidecar } from './private-store.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverTracker, trackerData } from './tracker-discovery.mjs';
import { readState, updateState } from './state.mjs';
import { loadEffectiveConfig } from './config.mjs';
import { resolveSettings } from './workspace-settings.mjs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export async function validatedUsageStorage(data, root) {
  if (!isAbsolute(data)) throw new Error('Tracker storage must be an absolute private data directory.');
  const canonicalRoot = await realpath(root);
  let ancestor = resolve(data), suffix = '';
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      suffix = join(ancestor.slice(dirname(ancestor).length), suffix); ancestor = dirname(ancestor);
    }
  }
  const target = resolve(ancestor, `.${suffix.startsWith('/') ? suffix : '/' + suffix}`);
  if (target === canonicalRoot || target.startsWith(canonicalRoot + '/') || canonicalRoot.startsWith(target + '/') || target === '/') throw new Error('Tracker storage must be separate from the application tree.');
  return target;
}
export async function usageControl(root, args, env = process.env, run = exec) {
  const current = await readState(root, env); if (!current.ok) return { available: false, reason: current.health };
  const config = (await loadEffectiveConfig(root, env)).config;
  const settings = resolveSettings(config, current.state).values;
  if (settings['usageTracker.mode'] !== 'on') return null;
  const command = args[0];
  if (!['report', 'snapshot'].includes(command)) throw new Error('usage requires report or snapshot --event start|checkpoint|progress|end [--checkpoint id]');
  const sessionId = current.state.workspace.activeSessionId;
  if (command === 'snapshot' && (!sessionId || !current.state.workspace.sessions[sessionId])) return { available: false, reason: 'Usage recording requires a bound session.', nonBlocking: true };
  try {
    const installation = await discoverTracker(settings, env);
    if (installation.status !== 'found') return { available: false, ...installation };
    const executable = installation.path;
    const milestone = current.state.workspace.activeMilestoneId;
    let event = null, checkpoint = '';
    if (command === 'snapshot') {
      if (![3, 5].includes(args.length) || args[1] !== '--event' || !['start', 'checkpoint', 'progress', 'end'].includes(args[2]) || args.length === 5 && (args[3] !== '--checkpoint' || !/^[A-Za-z0-9._-]{1,80}$/.test(args[4]))) throw new Error('invalid snapshot arguments');
      event = args[2]; checkpoint = args[4] ?? '';
    } else if (args.length !== 1) throw new Error('usage report takes no arguments');
    const key = `${sessionId}:${milestone}:${event}:${checkpoint}`;
    const saved = current.state.workspace.usageMarkers[key];
    if (event && saved && (event !== 'progress' || Date.now() - Date.parse(saved.at) < settings['usageTracker.progressMinutes'] * 60000)) return { duplicate: true, marker: saved };
    const requestId = createHash('sha256').update(`${root}:${key}:${event === 'progress' ? saved?.at ?? 'initial' : ''}`).digest('hex');
    const repository = await resolveRepositoryDirectory(root, config);
    const data = await validatedUsageStorage(await trackerData(executable, env), repository);
    const argv = command === 'report' ? [fileURLToPath(new URL('../tracker-read-only.py', import.meta.url)), '--read-only', '--database', join(data, 'usage.sqlite3'), '--project', root, '--milestone', milestone] : ['snapshot', '--request-id', requestId, '--project', root, '--milestone', milestone, '--event', event, ...(checkpoint ? ['--checkpoint', checkpoint] : [])];
    const { stdout } = await run(command === 'report' ? 'python3' : executable, argv, { env: { ...env, AI_USAGE_TRACKER_DATA: data }, cwd: dirname(executable), timeout: 10000, maxBuffer: 65536 });
    const result = JSON.parse(stdout);
    if (!result || typeof result !== 'object' || result.available === false || result.status === 'unavailable') return { available: false, reason: result?.reason ?? 'Tracker returned no usable receipt.', nonBlocking: true };
    if (event) {
      const stored = await updateState(root, state => { if (state.workspace.activeSessionId !== sessionId || state.workspace.activeMilestoneId !== milestone) throw new Error('Usage session changed; preserve the receipt without attributing it to another session.'); state.workspace.usageMarkers[key] = { at: new Date().toISOString(), event, checkpoint }; state.generation++; return state; }, { purpose: 'usage-marker-receipt' }, env);
      if (!stored.ok) return { ...result, warning: 'Snapshot succeeded but marker receipt could not be saved; inspect before retrying.' };
    }
    return result;
  } catch (error) { return { available: false, reason: error.message, nonBlocking: true }; }
}

export async function readUsageCache(root, installation, milestone, env = process.env, run = exec) {
  if (installation.status !== 'found') return { available: false, reason: installation.reason };
  try {
    const data = await trackerData(installation.path, env);
    const { stdout } = await run('python3', [fileURLToPath(new URL('../tracker-read-only.py', import.meta.url)), '--read-only', '--database', join(data, 'usage.sqlite3'), '--project', root, '--milestone', milestone], { env, timeout: 3000, maxBuffer: 65536 });
    return JSON.parse(stdout);
  } catch { return { available: false, reason: 'Cached allowance readings unavailable.' }; }
}

// A line is cached per delivery so Stop retries cannot rescan logs or change the
// reporting obligation. A later checkpoint retries failures; no readings invented.
export function usageLine(result) {
  if (result == null) return null;
  if (result.available === false) return `Usage unavailable: ${String(result.reason ?? 'tracker could not record this checkpoint').replace(/\s+/g, ' ').slice(0, 200)}.`;
  if (result.duplicate && !result.totals) return 'Usage: snapshot already recorded; token details unavailable in this receipt.';
  const providers = {};
  for (const [model, values] of Object.entries(result.totals ?? {})) {
    const provider = model.split('/')[0];
    if (!['claude', 'codex'].includes(provider)) continue;
    const counts = ['input', 'cache_read', 'cache_write', 'output'].map(key => values?.[key]);
    if (counts.every(n => Number.isSafeInteger(n) && n >= 0)) providers[provider] = (providers[provider] ?? 0) + counts.reduce((a, b) => a + b, 0);
  }
  const totals = Object.entries(providers).filter(([, n]) => Number.isSafeInteger(n)).map(([provider, n]) => `${provider}: ${n} tokens`);
  const missing = Array.isArray(result.missing_allowance_providers) && result.missing_allowance_providers.length ? ` Allowance unavailable: ${result.missing_allowance_providers.filter(p => ['claude', 'codex'].includes(p)).join(', ')}.` : '';
  const stale = result.allowances?.some(a => a.freshness !== 'recent') ? ' Some allowance readings are stale or expired.' : '';
  return `Usage: ${totals.length ? totals.join('; ') + ' recorded for this project (cumulative, including other sessions)' : 'no recorded project token totals available'}.${missing}${stale}${result.warning ? ' Receipt bookkeeping needs retry.' : ''}`;
}
export async function usageLifecycle(root, event, checkpoint, sessionId, env = process.env, collect = usageControl) {
  try {
    const current = await readState(root, env);
    if (!current.ok) return 'Usage unavailable: Fabex state could not be read.';
    const config = (await loadEffectiveConfig(root, env)).config;
    const settings = resolveSettings(config, current.state).values;
    if (settings['usageTracker.mode'] !== 'on') return null;
    if (current.state.workspace.activeSessionId !== sessionId) return 'Usage unavailable: the active session changed.';
    const key = createHash('sha256').update(JSON.stringify([sessionId, current.state.workspace.activeMilestoneId, event, checkpoint, settings['usageTracker.path'], config.project.repositoryRoot, env.AI_USAGE_TRACKER_DATA])).digest('hex');
    const file = await sidecar(root, 'usage-delivery.json', env);
    const cache = await readPrivate(file, { lines: {} });
    if (Object.hasOwn(cache.lines, key)) return cache.lines[key];
    const line = usageLine(await collect(root, ['snapshot', '--event', event, ...(checkpoint ? ['--checkpoint', checkpoint] : [])], env));
    await changePrivate(root, 'usage-delivery.json', { lines: {} }, data => {
      data.lines[key] = line;
      const keys = Object.keys(data.lines); for (const old of keys.slice(0, Math.max(0, keys.length - 256))) delete data.lines[old];
    }, env);
    return line;
  } catch (error) { return `Usage unavailable: ${String(error.message).replace(/\s+/g, ' ').slice(0, 200)}.`; }
}
