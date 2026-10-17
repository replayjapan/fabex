import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PLUGIN_ROOT } from './paths.mjs';

const exec = promisify(execFile);
const command = async (file, args, options = {}) => (await exec(file, args, { maxBuffer: 8 * 1024 * 1024, ...options })).stdout;

async function inspectNamedCopy(root, target, source, activeCheck) {
  if (!isAbsolute(source) || !isAbsolute(target) || resolve(source) !== source || resolve(target) !== target) throw new Error('cleanup requires exact absolute source and copy paths');
  const [src, dst, work] = await Promise.all([realpath(source), realpath(target), realpath(root)]);
  if (src !== source || dst !== target || src === dst || src.startsWith(dst + '/') || dst.startsWith(src + '/')) throw new Error('cleanup refuses redirected, nested or identical paths');
  if (![work, dirname(work)].includes(dirname(src)) && src !== work) throw new Error('cleanup source must be the workstream or an adjacent project');
  if (![work, dirname(src), await realpath(tmpdir())].includes(dirname(dst))) throw new Error('cleanup copy must be adjacent or in the temp root');
  const suffix = basename(dst).slice(basename(src).length);
  if (!basename(dst).startsWith(basename(src)) || !/^-next(?:\d+|-\d+\.\d+\.\d+)?$/.test(suffix)) throw new Error('cleanup copy name must be <source>-next[version or number]');
  const info = await lstat(dst);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('cleanup requires an ordinary copy directory');
  const manifest = JSON.parse(await readFile(join(src, '.claude-plugin/plugin.json'), 'utf8'));
  if (!manifest.name || typeof manifest.version !== 'string') throw new Error('source plugin manifest missing');
  let files = 0;
  const walk = async (dir, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!prefix && ['node_modules', '.git'].includes(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`cleanup refuses symlink: ${path}`);
      const baseline = join(src, path); let original;
      try { original = await lstat(baseline); } catch { throw new Error(`cleanup refuses unique file: ${path}`); }
      if (original.isSymbolicLink()) throw new Error(`cleanup refuses source symlink: ${path}`);
      if (entry.isDirectory() && original.isDirectory()) await walk(join(dir, entry.name), path + '/');
      else if (entry.isFile() && original.isFile() && (await readFile(join(dir, entry.name))).equals(await readFile(baseline))) files++;
      else throw new Error(`cleanup refuses differing file: ${path}`);
    }
  };
  await walk(dst);
  // A copied Git database can contain unique reflog/unreachable work even when
  // refs match. Generic cleanup refuses it rather than claiming it disposable.
  try { await lstat(join(dst, '.git')); throw new Error('generic cleanup refuses copied Git metadata; use the Fabex-specific audit'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!files) throw new Error('cleanup copy has no verified files');
  if (activeCheck) await activeCheck(dst);
  else try {
    if ((await command('lsof', ['-t', '+D', dst])).trim()) throw new Error('cleanup target is in active use');
  } catch (error) { if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim()) throw new Error(`cleanup cannot prove target idle: ${error.message}`); }
  return { path: dst, source: src, files, version: manifest.version, verified: true, device: info.dev, inode: info.ino };
}

// A manifest is not proof that a directory is disposable. Compare every source
// file, reject unique extras and refs, and require an OS active-use check.
export async function inspectCleanup(root, target, { source = PLUGIN_ROOT, activeCheck = null, namedSource = false } = {}) {
  if (namedSource) return inspectNamedCopy(root, target, source, activeCheck);
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
