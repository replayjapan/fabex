import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, realpath, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectPaths } from './paths.mjs';
import { processIdentity, sameIdentity } from './process-evidence.mjs';

// A permanent, generation-specific claim prevents two reclaimers from unlinking
// a replacement lock. Unknown/legacy locks are deliberately not guessed dead.
export async function reclaimPrivateLock(lockFile, { identity = processIdentity } = {}) {
  let owner;
  try { owner = await readPrivate(lockFile, null, 4096, 2); } catch { return false; }
  if (!owner?.token || !/^[0-9a-f-]{36}$/.test(owner.token) || !owner.identity?.signature) return false;
  try { if (sameIdentity(owner.identity, await identity(owner.identity.pid))) return false; } catch { return false; }
  let claimFile = `${lockFile}.reclaimed-${owner.token}`, claimed = false;
  // Immutable claim generations also recover a reclaimer that died before
  // unlinking. A live/unknown reclaimer is never competed with.
  for (let depth = 0; depth < 8; depth++) {
    const token = randomUUID(), temp = `${lockFile}.claim-${token}`;
    let own = null; try { own = await identity(process.pid); } catch {}
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ token, identity: own })); await handle.sync(); } finally { await handle.close(); }
    try { await link(temp, claimFile); claimed = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await unlink(temp); }
    if (claimed) break;
    let prior; try { prior = await readPrivate(claimFile, null, 4096, 2); } catch { return false; }
    if (!prior?.identity?.signature || !/^[0-9a-f-]{36}$/.test(prior.token ?? '')) return false;
    try { if (sameIdentity(prior.identity, await identity(prior.identity.pid))) return false; } catch { return false; }
    claimFile = `${lockFile}.reclaimed-${owner.token}-${prior.token}`;
  }
  if (!claimed) return false;
  const current = await readPrivate(lockFile, null, 4096, 2);
  if (current?.token !== owner.token) return false;
  await unlink(lockFile);
  return true;
}

export async function sidecar(root, name, env) {
  const paths = await projectPaths(root, env);
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error('invalid sidecar name');
  return join(paths.projectDir, name);
}
export async function readPrivate(file, fallback, limit = 256 * 1024, maxLinks = 1) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    // Only immutable lock evidence permits a second link: a publisher may die
    // between atomic link() and unlinking its prepared file. Data still requires
    // one link; lock reads never write through either alias.
    if (!stat.isFile() || stat.nlink < 1 || stat.nlink > maxLinks || stat.size > limit) throw new Error('unsafe private data file');
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
  const token = randomUUID();
  let ownerIdentity = null;
  try { ownerIdentity = await processIdentity(process.pid); } catch {} // unknown owners cannot be reclaimed
  let lock;
  let reclaimed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const prepared = `${lockFile}.prepared-${token}`;
    try {
      const handle = await open(prepared, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ token, identity: ownerIdentity, createdAt: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
      try { await link(prepared, lockFile); } finally { await unlink(prepared); }
      lock = await open(lockFile, constants.O_RDONLY | constants.O_NOFOLLOW); break;
    }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt === 59) throw error;
      if (await reclaimPrivateLock(lockFile)) { reclaimed = true; continue; }
      await new Promise(done => setTimeout(done, 25));
    }
  }
  const temp = file + '.' + randomUUID();
  try {
    const value = await readPrivate(file, fallback, limit);
    if (reclaimed) value.lockRecovery = { at: new Date().toISOString(), warning: 'Reclaimed a private lock with a verified dead owner.' };
    const result = await change(value);
    const text = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(text) > limit) throw new Error('private sidecar capacity exceeded');
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    return result;
  } finally {
    await unlink(temp).catch(() => {}); await lock.close();
    const current = await readPrivate(lockFile, null, 4096, 2);
    if (current?.token === token) await unlink(lockFile);
  }
}
