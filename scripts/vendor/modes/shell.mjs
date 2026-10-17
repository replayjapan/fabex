// Modes-owned shell effect classifiers, extracted from Fabex 1.11.1.
export function simpleTokens(command) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) return null;
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) { quote = null; started = true; }
      else if (quote === '"' && char === '\\') {
        const next = command[index + 1];
        if (next === undefined) return null;
        if (/\r|\n/.test(next)) { index += 1; continue; }
        // These are the only characters for which a backslash has quoting
        // meaning inside double quotes. They remain literal argv content.
        if (['"', '\\', '$', '`'].includes(next)) current += next;
        else current += `\\${next}`;
        started = true;
        index += 1;
      } else {
        if (quote === '"' && ['$', '`'].includes(char)) return null;
        current += char;
        started = true;
      }
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;
      if (/[\r\n]/.test(next)) { index += 1; continue; }
      current += next;
      started = true;
      index += 1;
    } else if (/\s/.test(char)) {
      if (/[\r\n]/.test(char)) return null;
      if (started) { tokens.push(current); current = ''; started = false; }
    } else {
      if (/[;&|<>`$()*?\[\]{}~#]/.test(char)) return null;
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}


export function readOnlyGithub(args) {
  const [area, action, ...rest] = args;
  const commands = { repo: ['view'], issue: ['view', 'list', 'status'], pr: ['view', 'list', 'status', 'diff', 'checks'], release: ['view', 'list'], run: ['view', 'list'], workflow: ['view', 'list'], search: ['repos', 'issues', 'prs', 'commits', 'code'] };
  if (area === 'api') {
    // No GraphQL, arbitrary hosts, fields (implicit POST), or input files.
    const endpoint = action;
    if (!/^(?:\/)?repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:contents|commits|branches|tags|releases|issues|pulls|actions\/runs)(?:\/[A-Za-z0-9_.\/-]+)?)?(?:\?[A-Za-z0-9_=&.%+-]*)?$/.test(endpoint ?? '') || endpoint.includes('..')) return false;
    for (let i = 0; i < rest.length; i++) {
      if (['--paginate', '--slurp', '--include', '--silent'].includes(rest[i])) continue;
      if (['--method', '-X'].includes(rest[i]) && rest[++i] === 'GET') continue;
      if (['--jq', '-q'].includes(rest[i]) && typeof rest[++i] === 'string') continue;
      return false;
    }
    return true;
  }
  if (!commands[area]?.includes(action)) return false;
  const valueFlags = new Set(['--repo', '-R', '--json', '--jq', '-q', '--limit', '-L', '--state', '-s', '--base', '-B', '--head', '-H', '--author', '--assignee', '--label', '-l', '--search', '-S', '--branch', '-b', '--commit', '--status', '--workflow', '-w', '--job', '-j']);
  const boolFlags = new Set(['--comments', '-c', '--patch', '--name-only', '--log', '--log-failed', '--exit-status', '--verbose', '--required']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('-')) continue;
    const flag = arg.split('=')[0];
    if (boolFlags.has(arg)) continue;
    if (!valueFlags.has(flag)) return false;
    if (!arg.includes('=') && typeof rest[++i] !== 'string') return false;
  }
  return true;
}


export function readOnlySed(args) {
  const scripts = []; let positional = false;
  for (let n = 0; n < args.length; n++) {
    const arg = args[n];
    if (!positional && ['-n', '-E', '-r', '-En', '-nE'].includes(arg)) continue;
    if (!positional && arg === '-e') { if (!args[n + 1]) return false; scripts.push(args[++n]); continue; }
    if (arg.startsWith('-')) return false;
    if (!scripts.length) scripts.push(arg);
    positional = true;
  }
  return scripts.length > 0 && scripts.every(script => !/[\r\n]/.test(script) && script.split(';').every(part => {
    const body = part.trim().replace(/^(?:\d+|\$)(?:,(?:\d+|\$))?\s*/, '');
    return /^[pdq=]$/.test(body) || /^s([^\w\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gIp0-9]*$/.test(body);
  }));
}


function allowedRedirectionAt(command, index, literal) {
  if (!command.startsWith(literal, index)) return false;
  const before = command[index - 1];
  const after = command[index + literal.length];
  const boundaryBefore = before === undefined || /\s/.test(before);
  const boundaryAfter = after === undefined || /\s/.test(after) || ['|', ';', '&'].includes(after);
  return boundaryBefore && boundaryAfter;
}

export function safeCommandSegments(command) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) return null;
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && command[index + 1] !== undefined) {
        current += command[index + 1];
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;
      if (/[\r\n]/.test(next)) {
        // A shell line continuation is whitespace within one logical command,
        // not a command boundary. Raw newlines remain denied below.
        current += ' ';
        index += 1;
        continue;
      }
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(') || (char === '<' && command[index + 1] === '(')) return null;
    const redirection = ['2>/dev/null', '>/dev/null', '1>/dev/null', '2>&1'].find((literal) => allowedRedirectionAt(command, index, literal));
    if (redirection) {
      current += ' ';
      index += redirection.length - 1;
      continue;
    }
    if (char === '>' || char === '<' || char === '&' && command[index + 1] !== '&') return null;
    const separatorLength = char === '&' && command[index + 1] === '&' ? 2 : ['|', ';'].includes(char) ? 1 : 0;
    if (separatorLength) {
      if (char === '|' && command[index + 1] === '|') return null;
      const segment = current.trim();
      if (!segment) return null;
      segments.push(segment);
      current = '';
      index += separatorLength - 1;
      continue;
    }
    if (/[\r\n]/.test(char)) return null;
    current += char;
  }
  if (quote || !current.trim()) return null;
  segments.push(current.trim());
  return segments;
}


// Extracted from Fabex's established Git read policy; shared by both plugins.
export function readOnlyTagArgs(args) {
  return ['--list', '-l'].includes(args[0]) && (args.length === 1 || args.length === 2 && !args[1].startsWith('-'));
}
export function readOnlyGit(args) {
  let cursor = 0;
  while (args[cursor]?.startsWith('-')) {
    if (args[cursor] === '-C' && typeof args[cursor + 1] === 'string') cursor += 2;
    else if (['--no-pager', '--no-optional-locks'].includes(args[cursor])) cursor++;
    else return false;
  }
  const subcommand = args[cursor], rest = args.slice(cursor + 1);
  if (subcommand === 'tag') return readOnlyTagArgs(rest);
  if (!['status','log','diff','show','branch','rev-parse','remote','ls-files','stash'].includes(subcommand)) return false;
  if (rest.some(arg => /^(?:--output|--ext-diff|--textconv|--exec|--open-files-in-pager)(?:=|$)/.test(arg))) return false;
  if (subcommand === 'branch') return rest.length === 0 || rest.every(arg => ['--show-current','--list','-a','--all','-r','--remotes','-v','-vv','--verbose'].includes(arg));
  if (subcommand === 'remote') return rest.length === 1 && rest[0] === '-v';
  if (subcommand === 'stash') return rest.length === 1 && rest[0] === 'list';
  return true;
}
