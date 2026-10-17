import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { researchRoot, safePath, readOnlyShell, simpleTokens, safeCommandSegments } from './policy.mjs';

// A shell parser is admission, not an execution sandbox. Read commands also run
// with OS write restrictions, so config-driven helpers cannot write app files.
export function readPlan(root, command, platform = process.platform) {
  if (!readOnlyShell(command)) throw new Error('Not a verified read command');
  if (platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('Contained shell reads require the macOS sandbox adapter; use Read/Grep/Glob on this host.');
  root = realpathSync(root);
  const cache = join(researchRoot(root), 'cache');
  if (!safePath(cache)) throw new Error('Linked research cache refused');
  // gh reads need HTTPS; other commands have no network authority.
  const segments = safeCommandSegments(command);
  const github = segments.some(s => simpleTokens(s)?.[0] === 'gh');
  if (github && (segments.length !== 1 || simpleTokens(command)?.[0] !== 'gh')) throw new Error('Run GitHub reads separately from local commands');
  const network = github ? '' : '(deny network*)';
  const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(cache)}))${network}`;
  return { cache, executable: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command], cwd: root };
}
export function runRead(root, command, sourceEnv = process.env) {
  const plan = readPlan(root, command);
  unlinkedTree(plan.cache);
  mkdirSync(plan.cache, { recursive: true, mode: 0o700 });
  const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: plan.cache, TMPDIR: plan.cache,
    XDG_CACHE_HOME: plan.cache, GH_CONFIG_DIR: plan.cache, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', RIPGREP_CONFIG_PATH: '/dev/null',
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null', GIT_CONFIG_KEY_2: 'diff.external', GIT_CONFIG_VALUE_2: '' };
  // Forward only GitHub authentication for admitted read-only gh commands.
  // Config remains readable at its original location; OS policy prevents writes.
  if (simpleTokens(command)?.[0] === 'gh') {
    env.GH_CONFIG_DIR = sourceEnv.GH_CONFIG_DIR || join(sourceEnv.HOME || '', '.config/gh');
    for (const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN']) if (sourceEnv[key]) env[key] = sourceEnv[key];
    env.GH_PROMPT_DISABLED = '1';
  }
  return spawnSync(plan.executable, plan.args, { cwd: plan.cwd, env, stdio: 'inherit', timeout: 60000 }).status ?? 1;
}
function unlinkedTree(root) {
  if (!safePath(root)) throw new Error('Linked research directory refused');
  if (!existsSync(root)) return;
  const walk = p => { for (const e of readdirSync(p, { withFileTypes: true })) {
    const file = join(p, e.name), s = lstatSync(file);
    if (s.isSymbolicLink() || !s.isDirectory() && (!s.isFile() || s.nlink !== 1)) throw new Error('Research contains a link or special file');
    if (s.isDirectory()) walk(file);
  } }; walk(root);
}
export function researchReadProfile(research, sourceEnv = process.env) {
  // Networked experiments receive a public runtime + research read surface,
  // not the application's files or the user's home directory. Native Read tools
  // remain available for project inspection outside this script runner.
  const homes = [...new Set([homedir(), sourceEnv.HOME].filter(Boolean))];
  const credentials = homes.flatMap(home => ['.ssh', '.aws', '.azure', '.kube', '.config', '.netrc', '.git-credentials', '.gitconfig', '.npmrc', '.pypirc', '.claude', '.codex', 'Library/Keychains', 'Library/Application Support', 'Library/Containers', 'Library/Group Containers', 'Library/Cookies', 'Library/Safari'].map(p => join(home, p)));
  credentials.push('/Library/Keychains', '/private/var/db/SystemKey', ...['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GH_CONFIG_DIR', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GIT_CONFIG_GLOBAL', 'KUBECONFIG'].flatMap(k => sourceEnv[k] ? sourceEnv[k].split(':').filter(p => p.startsWith('/')) : []));
  const paths = [...new Set(credentials.flatMap(p => existsSync(p) ? [p, realpathSync(p)] : [p]))];
  const publicRoots = ['/System/Library', '/System/Cryptexes', '/System/Volumes/Preboot/Cryptexes', '/usr', '/bin', '/sbin', '/opt/homebrew', '/opt/local', '/Library/Apple', '/Library/Frameworks', '/private/var/db/dyld', '/private/etc/ssl', '/dev', research];
  // libignition opens / as its openat root before Node starts (dyld-support.sb).
  // A user-installed Node needs its executable, never its surrounding home tree.
  const runtime = realpathSync(process.execPath);
  const ancestors = [];
  for (let p = dirname(runtime); p !== '/'; p = dirname(p)) ancestors.push(p);
  return '(deny file-read*)(allow file-read* (literal "/"))' +
    `(allow file-read* (literal ${JSON.stringify(runtime)}))` +
    ancestors.map(p => `(allow file-read-metadata (literal ${JSON.stringify(p)}))`).join('') + publicRoots.map(p => `(allow file-read* (subpath ${JSON.stringify(p)}))`).join('') +
    ['/private/etc/resolv.conf', '/private/etc/hosts', '/private/etc/localtime'].map(p => `(allow file-read* (literal ${JSON.stringify(p)}))`).join('') +
    paths.map(p => `(deny file-read* (subpath ${JSON.stringify(p)}))`).join('') +
    '(deny process-info*)(allow process-info* (target self))(deny mach-lookup)(allow mach-lookup (global-name "com.apple.mDNSResponder"))(deny appleevent-send)';
}
export function researchPlan(root, argv, platform = process.platform, sourceEnv = process.env) {
  if (platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('Research containment unavailable: this runner requires the macOS sandbox adapter.');
  root = realpathSync(root);
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string' || a.includes('\0')) || !argv[0]) throw new Error('Research requires a direct argv command after --');
  const research = researchRoot(root), cache = join(research, 'cache');
  unlinkedTree(research);
  // Child processes inherit the same write boundary. No application or global
  // cache writes, even through an absolute path or a link created during a run.
  // Network is available for research; this is not a remote-effect firewall.
  const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(research)}))${researchReadProfile(research, sourceEnv)}`;
  const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: cache, TMPDIR: cache,
    XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: cache, XDG_DATA_HOME: cache,
    npm_config_cache: join(cache,'npm'), npm_config_prefix: join(cache,'npm-prefix'),
    PYTHONPYCACHEPREFIX: join(cache,'python'), PLAYWRIGHT_BROWSERS_PATH: join(cache,'playwright'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false' };
  return { research, cache, executable:'/usr/bin/sandbox-exec', args:['-p',profile,...argv], cwd:research, env };
}
export function preflightResearch(root, argv) {
  const plan = researchPlan(root, argv);
  if (!existsSync(plan.research)) throw new Error('Create the research folder with the contained writer before running experiments');
  return plan;
}
export async function runResearch(root, argv) {
  const plan = preflightResearch(root, argv);
  mkdirSync(plan.cache, { recursive: true, mode: 0o700 });
  // A new process group belongs solely to this invocation. Terminate remaining
  // descendants when its leader exits or times out; never signal another group.
  return new Promise((resolveRun, reject) => {
    const child = spawn(plan.executable, plan.args, { cwd:plan.cwd, env:plan.env, stdio:'inherit', detached:true });
    let timedOut = false;
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid,'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    };
    const timer = setTimeout(() => { timedOut = true; try { terminate(); } catch(e) { reject(e); } },120000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', async (code) => {
      clearTimeout(timer);
      try {
        terminate();
        let empty=false;
        for(let attempt=0;attempt<30;attempt++) {
          const {stdout}=await promisify(execFile)('/bin/ps',['-axo','pid=,pgid='],{timeout:1000,maxBuffer:1024*1024});
          if(!stdout.trim().split('\n').some(line=>Number(line.trim().split(/\s+/)[1])===child.pid)) {empty=true;break;}
          await delay(100);
        }
        if(!empty) throw new Error('Research process group still exists; reservation retained for inspection');
        resolveRun(timedOut ? 124 : code ?? 1);
      } catch(e) { reject(e); }
    });
  });
}
