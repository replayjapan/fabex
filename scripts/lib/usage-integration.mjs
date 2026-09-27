import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { readState, updateState } from './state.mjs';
import { loadEffectiveConfig } from './config.mjs';
import { resolveSettings } from './workspace-settings.mjs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export async function usageControl(root, args, env = process.env, run = exec) {
  const current = await readState(root, env); if (!current.ok) return { available: false, reason: current.health };
  const settings = resolveSettings((await loadEffectiveConfig(root, env)).config, current.state).values;
  if (settings['usageTracker.mode'] !== 'on') return null;
  const command = args[0];
  if (!['report', 'snapshot'].includes(command)) throw new Error('usage requires report or snapshot --event start|checkpoint|progress|end [--checkpoint id]');
  if (command === 'snapshot' && current.state.route !== 'normal') return { deferred: true, reason: 'Recording requires work mode; use usage report for cached read-only information.' };
  try {
    const path = settings['usageTracker.path'];
    if (!path) return { available: false, reason: 'Tracker enabled but no installed launcher selected.' };
    const executable = await realpath(path); if (!(await stat(executable)).isFile()) throw new Error('configured tracker is not a file');
    const milestone = current.state.workspace.activeMilestoneId;
    let event = null, checkpoint = '';
    if (command === 'snapshot') {
      if (![3, 5].includes(args.length) || args[1] !== '--event' || !['start', 'checkpoint', 'progress', 'end'].includes(args[2]) || args.length === 5 && (args[3] !== '--checkpoint' || !/^[A-Za-z0-9._-]{1,80}$/.test(args[4]))) throw new Error('invalid snapshot arguments');
      event = args[2]; checkpoint = args[4] ?? '';
    } else if (args.length !== 1) throw new Error('usage report takes no arguments');
    const key = `${milestone}:${event}:${checkpoint}`;
    const saved = current.state.workspace.usageMarkers[key];
    if (event && saved && (event !== 'progress' || Date.now() - Date.parse(saved.at) < settings['usageTracker.progressMinutes'] * 60000)) return { duplicate: true, marker: saved };
    const requestId = createHash('sha256').update(`${root}:${key}:${event === 'progress' ? saved?.at ?? 'initial' : ''}`).digest('hex');
    let legacyData = false; try { legacyData = (await stat(join(dirname(executable), 'data'))).isDirectory(); } catch {}
    const data = env.AI_USAGE_TRACKER_DATA ?? (legacyData ? join(dirname(executable), 'data') : join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'ai-usage-tracker'));
    const argv = command === 'report' ? [fileURLToPath(new URL('../tracker-read-only.py', import.meta.url)), '--read-only', '--database', join(data, 'usage.sqlite3'), '--project', root, '--milestone', milestone] : ['snapshot', '--request-id', requestId, '--project', root, '--milestone', milestone, '--event', event, ...(checkpoint ? ['--checkpoint', checkpoint] : [])];
    const { stdout } = await run(command === 'report' ? 'python3' : executable, argv, { env, cwd: root, timeout: 10000, maxBuffer: 65536 });
    const result = JSON.parse(stdout);
    if (event) {
      const stored = await updateState(root, state => { state.workspace.usageMarkers[key] = { at: new Date().toISOString(), event, checkpoint }; state.generation++; return state; }, { purpose: 'usage-marker-receipt' }, env);
      if (!stored.ok) return { ...result, warning: 'Snapshot succeeded but marker receipt could not be saved; inspect before retrying.' };
    }
    return result;
  } catch (error) { return { available: false, reason: error.message, nonBlocking: true }; }
}
