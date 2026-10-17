// Private lock protocol reused from Fabex: identity-bound and generation-safe.
import { constants } from 'node:fs';
import { open, link, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const sameIdentity = (a,b) => Boolean(a && b && a.pid === b.pid && a.pgid === b.pgid && a.signature === b.signature);
export function parseProcessIdentity(pid, output) {
  if (!output) return null;
  const match = /^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(output);
  if (!match || Number(match[1]) !== pid) throw new Error('unrecognized process identity; refusing signals');
  return { pid, pgid: Number(match[2]), signature: `${match[3].replace(/\s+/g, ' ')}|${match[4]}` };
}
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('invalid process identity');
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'comm='], { timeout: 750, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' } });
    return parseProcessIdentity(pid, stdout.trim());
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return null;
    throw new Error('process inspection unavailable; ownership remains unknown');
  }
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

export async function acquireLock(lockFile, identity = processIdentity) {
  const token = randomUUID();
  let own = null;
  try { own = await identity(process.pid); } catch {} // unknown ownership is never guessed dead
  for(let n=0;n<60;n++) {
    const prepared = `${lockFile}.prepared-${token}`;
    try {
      const h=await open(prepared,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try { await h.writeFile(JSON.stringify({token,identity:own})); await h.sync(); } finally { await h.close(); }
      try { await link(prepared,lockFile); } finally { await unlink(prepared); }
      return async()=> { const current=await readPrivate(lockFile,null,4096,2); if(current?.token===token) await unlink(lockFile); };
    } catch(e) {
      if(e.code!=='EEXIST'||n===59) throw e;
      if(await reclaimPrivateLock(lockFile,{identity})) continue;
      await new Promise(r=>setTimeout(r,25));
    }
  }
}
