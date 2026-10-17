import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { inside } from './state.mjs';
import { simpleTokens, safeCommandSegments, readOnlyGithub, readOnlySed, readOnlyGit } from './shell.mjs';
export { simpleTokens, safeCommandSegments, readOnlyGithub, readOnlySed, readOnlyGit } from './shell.mjs';

// Until build/watcher exclusions are established, use the agreed sibling fallback.
// It avoids modifying application configuration or admitting executable research
// beneath application watchers merely because .gitignore happens to contain it.
export function researchRoot(root) { return join(dirname(root), '.modes-research', createHash('sha256').update(root).digest('hex').slice(0, 16)); }
export function safePath(path) {
  let p = resolve(path);
  while (true) {
    try {
      const s = lstatSync(p);
      if (s.isSymbolicLink() || s.isFile() && s.nlink !== 1 || !s.isDirectory() && !s.isFile()) return false;
    } catch (e) { if (e.code !== 'ENOENT') return false; }
    const parent = dirname(p); if (parent === p) return true; p = parent;
  }
}
export function writableTarget(root, target, input = {}) {
  if (typeof target !== 'string' || !target || target.includes('\0')) return false;
  root = realpathSync(root);
  const absolute = resolve(root, target), research = researchRoot(root), plans = join(root, 'Planning');
  if (!safePath(absolute)) return false;
  const parts = relative(inside(research, absolute) ? research : plans, absolute).split(/[\\/]/);
  if (parts.some(p => !p || p.startsWith('.') || /[\x00-\x1f]/.test(p))) return false;
  if (inside(research, absolute)) return true;
  if (!inside(plans, absolute) || !['active', 'parked', 'retired'].includes(parts[0]) || parts.length < 2 || !['.md', '.txt'].includes(extname(absolute))) return false;
  if (['AGENTS.MD','CLAUDE.MD','SKILL.MD'].includes(basename(absolute).toUpperCase())) return false;
  if (existsSync(absolute) && (lstatSync(absolute).mode & 0o111)) return false;
  const text = input.content ?? input.new_string ?? '';
  return typeof text === 'string' && !text.includes('\0') && !text.startsWith('#!');
}
export const researchMcpTools = Object.freeze({
  mobbin: ['search_apps','search_screens','search_flows','search_sections','get_app','get_screen','get_flow','list_apps'],
  context7: ['resolve-library-id','query-docs'],
  ide: ['getDiagnostics']
});
export function readOnlyMcp(tool) {
  const match = /^mcp__(mobbin|context7|ide|plugin_mobbin_mobbin|plugin_context7_context7)__(.+)$/.exec(tool);
  return Boolean(match && researchMcpTools[match[1].replace(/^plugin_(mobbin|context7)_/, '')]?.includes(match[2]));
}
function segmentRead(segment) {
  const words = simpleTokens(segment);
  if (!words?.length) return false;
  const [bin, ...args] = words;
  // Do not bless arbitrary executables by their basename or environment prefix.
  if (bin.includes('/') && !['/bin', '/usr/bin'].includes(dirname(bin))) return false;
  const name = basename(bin);
  if (name === 'gh') return readOnlyGithub(args);
  if (name === 'sed') return readOnlySed(args);
  if (name === 'find') return !args.some(a => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
  if (name === 'rg') return !args.some(a => /^(?:--pre|--hostname-bin)(?:=|$)/.test(a));
  if (name === 'file') return !args.some(a => a === '-C' || a === '--compile');
  if (name === 'sort') return !args.some(a => /^-o|^--(?:output|compress-program|random-source)(?:=|$)/.test(a));
  if (name === 'uniq') return args.every(a => !a.startsWith('-') || /^-[cdu]+$/.test(a)) && args.filter(a => !a.startsWith('-')).length <= 1;
  if (name === 'git') return readOnlyGit(args);
  if (name === 'ps') return args.length === 0 || args.length === 2 && args[0] === '-axo' && args[1].split(',').every(f => ['pid','ppid','rss','etime','stat','comm','lstart'].includes(f));
  if (name === 'pgrep') return args.every(a => !a.startsWith('-') || /^-[flinxv]+$/.test(a));
  if (name === 'node') return args.length === 1 && args[0] === '--version';
  if (['cat','ls','head','tail','wc','grep','diff','stat','which','echo','printf','pwd','du','cut','tr','column'].includes(name)) return true;
  return false;
}
export function readOnlyShell(command) { return Boolean(safeCommandSegments(command)?.every(segmentRead)); }
const deny = reason => ({ decision: 'deny', reason });
const defer = () => ({ decision: 'defer' });
export function classify({ toolName, toolInput = {}, permission, ownHelper = false }) {
  if (!permission || !['work', 'discussion', 'ask'].includes(permission.activity)) return deny('Modes permission evidence is unavailable. Read status before continuing.');
  if (['Skill', 'SlashCommand'].includes(toolName) && /^(?:modes|fabex):(?:work|discussion|ask)(?:Claude|Codex)?$/.test(toolInput.skill ?? toolInput.command ?? '')) return deny('Activity changes require an owner-typed command.');
  if (permission.activity === 'work') return defer(); // No extra authority beyond the host.
  if (['Read','Glob','Grep','ToolSearch','Skill','AskUserQuestion'].includes(toolName)) return defer();
  if (['Write','Edit'].includes(toolName)) return writableTarget(permission.root, toolInput.file_path ?? toolInput.path, toolInput) ? defer() : deny('Discussion writes are limited to unlinked text plans in Planning/{active,parked,retired} and the isolated research directory.');
  if (toolName === 'Bash') return readOnlyShell(toolInput.command) ? defer() : deny('Use the contained Modes research runner for experiments; application writes, installs and publishing are unavailable in Discussion.');
  if (toolName === 'WebSearch' && typeof toolInput.query === 'string') return defer();
  if (toolName === 'WebFetch') {
    try { const u = new URL(toolInput.url); if (['http:','https:'].includes(u.protocol) && !u.username && !u.password) return defer(); } catch {}
  }
  if (['Agent','Task'].includes(toolName)) return toolInput.isolation || toolInput.run_in_background ? deny('Research helpers must inherit this session and its foreground hooks; worktree and background helpers are unavailable.') : defer(); // Every helper inherits the hook policy.
  if (['SendMessage','TaskOutput'].includes(toolName) && ownHelper && (toolName !== 'SendMessage' || toolInput.type === 'message')) return defer();
  if (readOnlyMcp(toolName ?? '')) return defer();
  return deny('This tool has no verified read-only research effect.');
}
