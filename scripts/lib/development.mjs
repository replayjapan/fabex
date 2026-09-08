import { constants, openSync, closeSync, readFileSync, fstatSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const managers = new Set(['npm', 'pnpm', 'yarn']);
const sensitive = /\b(?:migrat\w*\s+(?:fresh|reset)|db\s+reset|dropdb|DROP\s+(?:DATABASE|TABLE|SCHEMA)|sudo)\b/i;
const mutations = /^(?:--update|-u|--update-snapshot|--write|--fix|--force)(?:=|$)/;
const portNumber = value => /^\d{1,5}$/.test(String(value)) && Number(value) > 0 && Number(value) <= 65535;
function contained(path, root) {
  const actual = realpathSync(resolve(root, path));
  const rel = relative(realpathSync(root), actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('development directory must resolve inside the workstream');
  return actual;
}
function manifest(cwd) {
  const fd = openSync(join(cwd, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 128 * 1024) throw new Error('package.json is not a bounded regular file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

// Only literal words: no expansion, redirection, substitution or arbitrary shell.
export function developmentWords(text) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 8192 || /[\0\r\n;&|<>`$(){}\[\]*?!#\\]/.test(text)) throw new Error('development command needs a direct literal argv shape');
  const words = []; let current = ''; let quote = null;
  for (const char of text) {
    if (quote) { if (char === quote) quote = null; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) words.push(current); current = ''; }
    else current += char;
  }
  if (quote) throw new Error('unclosed development command quote');
  if (current) words.push(current);
  return words;
}
export function serverArguments(args) {
  if (args.length > 32 || args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 512 || /[\0\r\n;&|<>`$(){}\[\]*?!#\\]/.test(arg) || mutations.test(arg))) throw new Error('unsafe development arguments');
  let port = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && i === 0) continue;
    if (['--turbo', '--turbopack', '--webpack', '--strictPort', '--strict-port'].includes(arg)) continue;
    const [flag, inline] = arg.split('=', 2);
    if (['--port', '-p'].includes(flag)) {
      const value = inline ?? args[++i];
      if (!portNumber(value) || port !== null && port !== Number(value)) throw new Error('invalid or competing development ports');
      port = Number(value); continue;
    }
    if (['--hostname', '--host', '-H'].includes(flag)) {
      const value = inline ?? args[++i];
      if (!['localhost', '127.0.0.1', '0.0.0.0', '::', '::1'].includes(value)) throw new Error('unsupported development bind address');
      continue;
    }
    throw new Error(`development argument ${arg} needs separate review; it is not a server bind/build-mode flag`);
  }
  return port;
}

export function inspectDevelopmentScript(cwd, script) {
  const pkg = manifest(cwd);
  const seen = new Set();
  const notes = [];
  const inspect = name => {
    if (seen.has(name) || seen.size >= 12) throw new Error(`recursive development script ${name}`);
    seen.add(name);
    const body = pkg.scripts?.[name];
    if (typeof body !== 'string' || !body.trim()) throw new Error(`package.json has no ${name} script`);
    const match = sensitive.exec(body);
    if (match) throw new Error(`script ${name}: destructive or privileged operation ${match[0]}`);
    if (/(?:NODE_ENV=["']?production|\.env\.production)/i.test(body) && /\b(?:migrat\w*|seed\w*|db:push)\b/i.test(body)) throw new Error(`script ${name}: production database mutation`);
    notes.push(`Script ${name}: review its actual development target and effects; detection is not a safety verdict.`);
    for (const hook of [`pre${name}`, `post${name}`]) if (pkg.scripts?.[hook]) inspect(hook);
    // Unknown launchers/chains require executor effect review, not activation.
    let args;
    try { args = developmentWords(body); }
    catch { return { framework: null, port: Number(/(?:--port[= ]|-p |PORT=)(\d+)/.exec(body)?.[1] ?? 3000) }; }
    if (args[0] === 'cross-env') args.shift();
    let envPort = null;
    while (args[0]?.includes('=') && !args[0].startsWith('-')) {
      const assignment = args.shift();
      if (/^PORT=\d+$/.test(assignment) && portNumber(assignment.slice(5))) envPort = Number(assignment.slice(5));
      // Environment overrides are reviewed operational effects, not activation gates.
    }
    let framework = args.shift();
    if (managers.has(framework)) {
      if (args[0] === 'run') args.shift();
      if (args.length !== 1) return { framework: null, port: envPort ?? 3000 };
      return inspect(args[0]);
    }
    const verbs = { next: ['dev', 'start'], vite: ['dev', 'serve', 'preview'], astro: ['dev', 'preview'], nuxt: ['dev', 'start'], 'react-scripts': ['start'], webpack: ['serve'] };
    if (!verbs[framework]) return { framework: null, port: envPort ?? Number(/(?:--port[= ]|-p )(\d+)/.exec(body)?.[1] ?? 3000) };
    if (verbs[framework].includes(args[0])) args.shift();
    else if (framework !== 'vite') return { framework: null, port: envPort ?? 3000 };
    let flagPort;
    try { flagPort = serverArguments(args); } catch { flagPort = Number(/(?:--port[= ]|-p )(\d+)/.exec(body)?.[1] ?? 0) || null; }
    if (flagPort && envPort && flagPort !== envPort) throw new Error(`script ${name} has competing port settings`);
    return { framework, port: flagPort ?? envPort ?? ({ vite: 5173, astro: 4321, webpack: 8080 }[framework] ?? 3000) };
  };
  return { ...inspect(script), script, notes };
}

export function developmentInvocation(tokens, root, config, invocationCwd = root) {
  if (!tokens || !managers.has(tokens[0])) return null;
  const manager = tokens[0]; const args = tokens.slice(1);
  let directory = invocationCwd;
  const selector = { pnpm: ['--dir', '-C'], npm: ['--prefix'], yarn: ['--cwd'] }[manager];
  if (selector.includes(args[0])) { args.shift(); directory = args.shift(); if (!directory) throw new Error('development directory selector needs a path'); directory = resolve(invocationCwd, directory); }
  if (args[0] === 'run') args.shift();
  const script = args.shift();
  if (!['dev', 'start'].includes(script)) return null;
  const cwd = contained(directory, root);
  // Check the directory the shell will actually use, never pretend a bare command
  // executes in repositoryRoot when the host cwd is somewhere else.
  const inspected = inspectDevelopmentScript(cwd, script);
  const port = serverArguments(args) ?? inspected.port;
  return { cwd, command: tokens, script, port };
}

export function detectDevelopment(root, config = {}) {
  const canonical = realpathSync(root);
  const candidates = [];
  if (config.project?.repositoryRoot) candidates.push(contained(config.project.repositoryRoot, canonical));
  else {
    let visited = 0;
    const scan = (dir, depth) => {
      if (++visited > 256) throw new Error('development discovery limit reached; name the application directory');
      if (existsSync(join(dir, 'package.json'))) {
        const pkg = manifest(dir);
        if (pkg.scripts?.dev || pkg.scripts?.start) candidates.push(dir);
      }
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.length > 2048) throw new Error('development discovery directory limit reached');
      if (depth >= 4) return;
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'dist', 'build', 'vendor', 'coverage'].includes(entry.name)) scan(join(dir, entry.name), depth + 1);
    };
    scan(canonical, 0);
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? `several development applications: ${candidates.map(path => relative(canonical, path) || '.').join(', ')}; name one directory` : 'no development application found; name its directory or command');
  const cwd = candidates[0]; const pkg = manifest(cwd);
  const script = pkg.scripts?.dev ? 'dev' : 'start';
  const inspected = inspectDevelopmentScript(cwd, script);
  const declared = /^(pnpm|npm|yarn)@/.exec(pkg.packageManager ?? '')?.[1];
  if (pkg.packageManager && !declared) throw new Error('unsupported packageManager declaration; name the supported package manager explicitly');
  const locks = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']].filter(([file]) => existsSync(join(cwd, file))).map(([, manager]) => manager);
  if (!declared && locks.length > 1) throw new Error('competing package-manager lockfiles; name the package manager');
  const manager = declared ?? locks[0] ?? 'npm';
  const portArgs = !inspected.framework || inspected.framework === 'react-scripts' ? [] : [...(manager === 'npm' ? ['--'] : []), '--port', String(inspected.port), ...(inspected.framework === 'vite' ? ['--strictPort'] : [])];
  return { cwd, start: [manager, 'run', script, ...portArgs], port: inspected.port, readyUrl: `http://localhost:${inspected.port}/`, readyTimeoutMs: 30000, stopGraceMs: 5000 };
}

// A probe may not load curl config, write a file, use a proxy, send a body or
// follow a redirect off loopback. Require a timeout instead of unbounded reads.
export function developmentProbe(tokens, env = process.env) {
  if (!tokens) return false;
  if (tokens[0] === 'lsof') {
    const args = tokens.slice(1);
    return args.length === 3 && args[0] === '-nP' && /^-iTCP:\d+$/.test(args[1]) && portNumber(args[1].slice(6)) && args[2] === '-sTCP:LISTEN'
      || args.length === 2 && args[0] === '-i' && /^:\d+$/.test(args[1]) && portNumber(args[1].slice(1));
  }
  if (tokens[0] !== 'curl') return false;
  const args = tokens.slice(1); let url = null; let timeout = false; let redirects = false; let zeroRedirects = false; let noProxy = false;
  if (args[0] === '-q' || args[0] === '--disable') args.shift();
  else if ([env.CURL_HOME, env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'), env.HOME ?? homedir()].filter(Boolean).some(dir => existsSync(join(dir, '.curlrc')) || existsSync(join(dir, 'curlrc')))) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-[sSIf]+$/.test(arg) || ['--silent', '--show-error', '--head', '--fail'].includes(arg)) continue;
    if (['-L', '--location'].includes(arg)) { redirects = true; continue; }
    if (arg === '--max-redirs' && args[++i] === '0') { zeroRedirects = true; continue; }
    if (arg === '--noproxy' && args[++i] === '*') { noProxy = true; continue; }
    if (['--max-time', '-m'].includes(arg)) { const value = args[++i]; if (!/^\d+(?:\.\d+)?$/.test(value ?? '') || Number(value) <= 0 || Number(value) > 30) return false; timeout = true; continue; }
    if (['-X', '--request'].includes(arg) && ['GET', 'HEAD'].includes(args[++i])) continue;
    if (['-o', '--output'].includes(arg) && args[++i] === '/dev/null') continue;
    if (['-w', '--write-out'].includes(arg)) {
      const format = args[++i];
      if (typeof format !== 'string' || format.length > 256 || /[%@{}]/.test(format.replace(/%\{(?:http_code|response_code|time_total)\}/g, ''))) return false;
      continue;
    }
    if (url !== null) return false;
    try { const parsed = new URL(arg); if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname) || !portNumber(parsed.port) || parsed.username || parsed.password || parsed.hash || arg.length > 2048) return false; url = arg; } catch { return false; }
  }
  const proxy = ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'].some(key => env[key]);
  return Boolean(url && timeout && (!redirects || zeroRedirects) && (!proxy || noProxy));
}
