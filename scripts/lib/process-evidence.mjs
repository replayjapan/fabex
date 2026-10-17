import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseProcessIdentity } from './dev-server.mjs';

const exec = promisify(execFile);
export const sameIdentity = (a, b) => Boolean(a && b && a.pid === b.pid && a.pgid === b.pgid && a.signature === b.signature);
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
export async function groupMembers(pgid) {
  if (!Number.isInteger(pgid) || pgid < 2) throw new Error('invalid process group');
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { timeout: 750, maxBuffer: 1024 * 1024 });
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error('unrecognized process group output');
    return { pid: Number(match[1]), pgid: Number(match[2]), zombie: match[3].startsWith('Z') };
  }).filter(row => row.pgid === pgid && !row.zombie).map(row => row.pid);
}
export async function verifiedGone(record, { identity = processIdentity, members = groupMembers } = {}) {
  if (!record || !Number.isInteger(record.pid) || record.pid < 2 || !Number.isInteger(record.pgid) || record.pgid < 2 || typeof record.signature !== 'string' || !record.signature) return false;
  try {
    // Even a reused PID is not evidence that its old group is empty.
    if (await identity(record.pid)) return false;
    return (await members(record.pgid)).length === 0;
  } catch { return false; }
}
