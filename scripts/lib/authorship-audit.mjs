import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isDocumentationTarget } from './authorship.mjs';

const run = promisify(execFile);
function boundedText(text, limit) {
  let result = '', bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    result += character;
  }
  return result;
}
// Observe project files without following links or scanning installed dependencies.
// In Git projects the scope is tracked and non-ignored untracked files.
export async function captureAuthorship(root) {
  const snapshot = { root, files: new Map(), incomplete: false };
  let names;
  try {
    names = (await run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 4 * 1024 * 1024, timeout: 10000 })).stdout.split('\0').filter(Boolean);
  } catch {
    names = [];
    async function walk(dir = '') {
      for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
        if (['.git', 'node_modules'].includes(entry.name)) continue;
        if (names.length >= 20000) { snapshot.incomplete = true; return; }
        const name = join(dir, entry.name);
        if (entry.isDirectory()) await walk(name); else names.push(name);
      }
    }
    try { await walk(); } catch { snapshot.incomplete = true; }
  }
  names = [...new Set(names)].sort();
  if (names.length > 20000) snapshot.incomplete = true;
  let bytes = 0;
  for (const name of names.slice(0, 20000)) {
    try {
      const path = join(root, name), stat = await lstat(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) { snapshot.incomplete = true; continue; }
      // Bound snapshot memory and report skipped files instead of claiming a pass.
      if (stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 128 * 1024 * 1024) { snapshot.incomplete = true; continue; }
      const content = stat.isSymbolicLink() ? await readlink(path) : await readFile(path);
      snapshot.files.set(name, {
        hash: createHash('sha256').update(content).update(`:${stat.mode}:${stat.nlink}`).digest('hex'),
        document: isDocumentationTarget(name, root)
      });
    } catch (error) { if (error.code !== 'ENOENT') snapshot.incomplete = true; }
  }
  return snapshot;
}

export function authorshipWarning(before, after, appliedTests = new Set()) {
  const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].sort().filter(name => {
    const a = before.files.get(name), b = after.files.get(name);
    return !appliedTests.has(name) && a?.hash !== b?.hash && (a && !a.document || b && !b.document);
  });
  if (!changed.length && !before.incomplete && !after.incomplete) return null;
  const shown = [];
  for (const name of changed) {
    const quoted = JSON.stringify(name);
    if (Buffer.byteLength([...shown, quoted].join(', ')) > 450) {
      if (!shown.length) shown.push(`${boundedText(quoted, 400)}… [path shortened]`);
      break;
    }
    shown.push(quoted);
  }
  return [
    changed.length ? `Authorship check: non-document files changed during a Codex turn while Claude was the selected Coding AI: ${shown.join(', ')}${changed.length > shown.length ? ` (${changed.length - shown.length} more; file list shortened)` : ''}.` : 'Authorship check incomplete.',
    before.incomplete || after.incomplete ? 'Some project files could not be checked.' : '',
    'This is detection after execution, not prevention or proof of which process wrote the files. Review before delivery.'
  ].filter(Boolean).join(' ');
}

export const mergeWarnings = (...warnings) => boundedText(warnings.filter(Boolean).join('\n'), 1024) || null;
