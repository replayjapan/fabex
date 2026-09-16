import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectPaths } from './paths.mjs';

export async function sidecar(root, name, env) {
  const paths = await projectPaths(root, env);
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error('invalid sidecar name');
  return join(paths.projectDir, name);
}
export async function readPrivate(file, fallback, limit = 256 * 1024) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('unsafe private data file');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
  finally { await handle?.close(); }
}
// Independent short lock, not the canonical state lock. Never evict an unknown lock.
export async function changePrivate(root, name, fallback, change, env, limit = 256 * 1024) {
  const paths = await projectPaths(root, env);
  if (paths.projectDir === paths.canonicalRoot || paths.projectDir.startsWith(paths.canonicalRoot + '/')) throw new Error('private sidecars must be outside the workstream');
  await mkdir(paths.projectDir, { recursive: true, mode: 0o700 });
  const real = await realpath(paths.projectDir);
  if (real === paths.canonicalRoot || real.startsWith(paths.canonicalRoot + '/')) throw new Error('private sidecars must be outside the workstream');
  const file = await sidecar(root, name, env), lockFile = file + '.lock';
  let lock;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { lock = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST' || attempt === 59) throw error; await new Promise(done => setTimeout(done, 25)); }
  }
  const temp = file + '.' + randomUUID();
  try {
    const value = await readPrivate(file, fallback, limit);
    const result = await change(value);
    const text = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(text) > limit) throw new Error('private sidecar capacity exceeded');
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    return result;
  } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(lockFile); }
}
