import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PLUGIN_ROOT } from './paths.mjs';

const exec = promisify(execFile);
const command = async (file, args, options = {}) => (await exec(file, args, { maxBuffer: 8 * 1024 * 1024, ...options })).stdout;

// A manifest is not proof that a directory is disposable. Compare every source
// file, reject unique extras and refs, and require an OS active-use check.
export async function inspectCleanup(root, target, { source = PLUGIN_ROOT, activeCheck = null } = {}) {
  if (!isAbsolute(target) || resolve(target) !== target || !/^fabex-next(?:-\d+\.\d+\.\d+)?$/.test(basename(target))) throw new Error('cleanup requires an exact absolute Fabex working-copy directory');
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('cleanup target must be a directory, never a symlink');
  const real = await realpath(target);
  const parents = await Promise.all([root, tmpdir()].map((path) => realpath(path)));
  // macOS exposes both /tmp and /private/tmp.
  try { parents.push(await realpath('/tmp')); } catch {}
  if (!parents.includes(dirname(real)) || real === await realpath(source)) throw new Error('cleanup target must be a direct child of the workstream or temp root, not the live plugin');
  const manifest = JSON.parse(await readFile(join(real, '.claude-plugin/plugin.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(real, 'package.json'), 'utf8'));
  if (manifest.name !== 'fabex' || pkg.name !== 'fabex' || manifest.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(manifest.version) || basename(real) !== 'fabex-next' && basename(real) !== `fabex-next-${manifest.version}`) throw new Error('cleanup manifest/package/name mismatch');
  const sourceManifest = JSON.parse(await readFile(join(source, '.claude-plugin/plugin.json'), 'utf8'));
  const current = sourceManifest.version === manifest.version;
  const ref = `refs/tags/v${manifest.version}`;
  const git = (args, cwd = source) => command('git', ['-C', cwd, ...args]);
  const tracked = (await git(current ? ['ls-files', '-z'] : ['ls-tree', '-rz', '--name-only', ref])).split('\0').filter(Boolean);
  const expected = new Set(tracked);
  // Include new, not-yet-delivered source files when auditing this release copy.
  if (current) for (const path of (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) expected.add(path);
  const walk = async (dir, prefix = '') => {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!prefix && ['.git', 'node_modules'].includes(entry.name)) continue;
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`cleanup refuses source symlink: ${relative}`);
      if (entry.isDirectory()) files.push(...await walk(join(dir, entry.name), relative + '/'));
      else files.push(relative);
    }
    return files;
  };
  for (const path of await walk(real)) {
    let baseline;
    if (!expected.has(path)) {
      // A copied ignored local setting is disposable only if its exact bytes
      // still exist in the live tree. Never remove the live setting itself.
      try {
        const original = await lstat(join(source, path));
        if (!original.isFile() || original.isSymbolicLink()) throw new Error('not an ordinary file');
        baseline = await readFile(join(source, path));
      } catch { throw new Error(`cleanup refuses unique/untracked file: ${path}`); }
    } else baseline = current ? await readFile(join(source, path)) : Buffer.from(await command('git', ['-C', source, 'show', `${ref}:${path}`], { encoding: 'buffer' }));
    if (!(await readFile(join(real, path))).equals(baseline)) throw new Error(`cleanup refuses differing file: ${path}`);
  }
  const sourceRefs = new Set((await git(['for-each-ref', '--format=%(objectname) %(refname)'])).trim().split('\n'));
  if (!(await lstat(join(real, '.git'))).isDirectory()) throw new Error('cleanup requires an ordinary copied git directory');
  for (const line of (await git(['for-each-ref', '--format=%(objectname) %(refname)'], real)).trim().split('\n')) {
    if (!line || sourceRefs.has(line)) continue;
    const [object, refName] = line.split(' ');
    // The copy's main/remote branch normally predates delivery. Require proof
    // that this same live ref still contains its complete history.
    if (!/^refs\/(heads|remotes)\//.test(refName) || ![...sourceRefs].some((entry) => entry.endsWith(` ${refName}`))) throw new Error('cleanup refuses a unique git ref');
    try { await git(['merge-base', '--is-ancestor', object, refName]); }
    catch { throw new Error('cleanup refuses unique git history'); }
  }
  if (activeCheck) await activeCheck(real);
  else {
    try {
      const pids = await command('lsof', ['-t', '+D', real]);
      if (pids.trim()) throw new Error('cleanup target is in active use');
    } catch (error) {
      if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim()) throw new Error(`cleanup cannot prove target idle: ${error.message}`);
    }
  }
  return { path: real, version: manifest.version, verified: true, device: info.dev, inode: info.ino };
}

export async function cleanupWorkingCopy(root, target, options) {
  const verified = await inspectCleanup(root, target, options);
  const current = await lstat(target);
  if (current.isSymbolicLink() || current.dev !== verified.device || current.ino !== verified.inode) throw new Error('cleanup target changed during verification');
  await rm(verified.path, { recursive: true, force: false });
  return { removed: verified.path, version: verified.version, recoverable: 'source files verified against the live checkout or delivered tag; no unique files removed' };
}
