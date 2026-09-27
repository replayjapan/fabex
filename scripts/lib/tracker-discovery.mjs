import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export const TRACKER_INSTALL = ['/plugin marketplace add replayjapan/ai-usage-tracker', '/plugin install ai-usage-tracker@ai-usage-tracker'];

async function candidate(path, source, explicit = false) {
  try {
    if (!isAbsolute(path)) return null;
    const launcher = await realpath(path);
    if (!(await stat(launcher)).isFile()) return null;
    if (!explicit) await access(launcher, constants.X_OK);
    // Discovery verifies package identity without executing a generic track.
    // Explicit owner overrides retain compatibility with custom launchers.
    if (!explicit) {
      const root = dirname(launcher);
      const manifest = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8'));
      if (manifest.name !== 'ai-usage-tracker' || !(await stat(join(root, 'usage_tracker.py'))).isFile()) return null;
      if (!/^name: weekly-tracker$/m.test(await readFile(join(root, 'skills/weekly-tracker/SKILL.md'), 'utf8'))) return null;
    }
    return { path: launcher, source };
  } catch { return null; }
}

export async function discoverTracker(settings = {}, env = process.env) {
  const override = settings['usageTracker.path'];
  if (override) {
    const found = await candidate(override, 'explicit setting', true);
    return found ? { status: 'found', ...found, candidates: [found] } : { status: 'invalid', reason: 'The configured launcher is unavailable; fix or clear the explicit path.', candidates: [] };
  }
  const home = env.HOME || homedir(), claude = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const requests = [];
  if (env.AI_USAGE_TRACKER) requests.push([env.AI_USAGE_TRACKER, 'AI_USAGE_TRACKER']);
  // The registry excludes uninstalled or obsolete cache directories.
  try {
    const registry = JSON.parse(await readFile(join(claude, 'plugins/installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(registry.plugins ?? {}).slice(0, 512)) {
      if (key.split('@')[0] !== 'ai-usage-tracker') continue;
      for (const entry of (Array.isArray(entries) ? entries : [entries]).slice(0, 32)) {
        if (typeof entry.installPath === 'string') requests.push([join(entry.installPath, 'track'), 'installed Claude plugin']);
      }
    }
  } catch {}
  for (const skills of [join(claude, 'skills'), join(home, '.agents/skills'), join(env.CODEX_HOME || join(home, '.codex'), 'skills')]) {
    try { requests.push([join(dirname(dirname(dirname(await realpath(join(skills, 'weekly-tracker/SKILL.md'))))), 'track'), 'user Weekly Tracker skill']); } catch {}
  }
  for (const folder of (env.PATH ?? '').split(delimiter).filter(isAbsolute).slice(0, 128)) requests.push([join(folder, 'track'), 'PATH']);
  const unique = new Map();
  for (const [path, source] of requests) {
    const found = await candidate(path, source);
    if (found && !unique.has(found.path)) unique.set(found.path, found);
  }
  const candidates = [...unique.values()];
  if (candidates.length === 1) return { status: 'found', ...candidates[0], candidates };
  return { status: candidates.length ? 'ambiguous' : 'not-installed', candidates, reason: candidates.length ? 'Several tracker installations found. Select one explicitly; none was run.' : 'AI Usage Tracker is not installed or no valid launcher was found.' };
}

export async function trackerData(launcher, env = process.env) {
  let legacy = false; try { legacy = (await stat(join(dirname(launcher), 'data'))).isDirectory(); } catch {}
  return env.AI_USAGE_TRACKER_DATA ?? (legacy ? join(dirname(launcher), 'data') : join(env.XDG_DATA_HOME ?? join(env.HOME || homedir(), '.local', 'share'), 'ai-usage-tracker'));
}
