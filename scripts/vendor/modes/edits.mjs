import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, readFileSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writableTarget, researchRoot, safePath } from './policy.mjs';
const digest = data => createHash('sha256').update(data).digest('hex');
export const editInstructions = 'DISCUSSION WRITES: Your native tools remain read-only; read-only research MCP tools, research networking and web search remain available under host permissions. Do not change remote data or publish. Return the normal review plus researchEdits: at most 16 {path, expectedHash, content} records. expectedHash is SHA-256 of existing bytes, or null for a new file; content is complete replacement text. Paths must be text plans under Planning/active, Planning/parked or Planning/retired, or files within the stated isolated research directory. No deletions, links, application files or real-data changes. The controller validates and applies these proposals after reconciliation. Do not claim they were applied yet.';
export function extendSchema(schema) {
  const copy = structuredClone(schema);
  copy.properties.researchEdits = { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, expectedHash: { type: ['string', 'null'] }, content: { type: 'string' } }, required: ['path','expectedHash','content'] } };
  copy.required.push('researchEdits'); return copy;
}
export function splitEdits(raw) {
  if (Buffer.byteLength(raw) > 320 * 1024) throw new Error('Research response too large');
  const { researchEdits, ...review } = JSON.parse(raw);
  if (!Array.isArray(researchEdits) || researchEdits.length > 16 || Buffer.byteLength(JSON.stringify(researchEdits)) > 256 * 1024) throw new Error('Invalid research edits');
  return { edits: researchEdits, review: JSON.stringify(review) };
}
export function applyEdits(root, edits) {
  const seen = new Set();
  const batch = edits.map(e => {
    if (!e || Object.keys(e).sort().join(',') !== 'content,expectedHash,path' || typeof e.content !== 'string' || !writableTarget(root, e.path, e) || !(e.expectedHash === null || /^[a-f0-9]{64}$/.test(e.expectedHash))) throw new Error('Invalid research target');
    const path = resolve(root, e.path);
    if (seen.has(path)) throw new Error('Duplicate research target'); seen.add(path);
    const old = existsSync(path) ? readFileSync(path) : null;
    if ((old === null ? null : digest(old)) !== e.expectedHash) throw new Error('Research target changed since review');
    return { ...e, path, old };
  });
  // The controller holds the Fabex state lock during application. No native SDK
  // writer is running. O_NOFOLLOW, link checks and atomic rename avoid following
  // destination links; revalidate parents before each write.
  const written = [];
  try {
    for (const e of batch) {
      if (!safePath(e.path) || (existsSync(e.path) ? digest(readFileSync(e.path)) : null) !== e.expectedHash) throw new Error('Research target changed during application');
      mkdirSync(dirname(e.path), { recursive: true, mode: 0o700 });
      if (!safePath(e.path)) throw new Error('Research parent became linked');
      const temp = e.path + '.modes-' + randomUUID();
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, e.content); } finally { closeSync(fd); }
      try { if (!safePath(e.path)) throw new Error('Research target became linked'); renameSync(temp, e.path); } finally { if (existsSync(temp)) unlinkSync(temp); }
      written.push(e.path);
    }
  } catch (e) { throw new Error(`${e.message}; applied paths: ${written.join(', ') || 'none'}. Inspect before retrying.`); }
  return written;
}

export function decodeEdits(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid encoded research edits');
  const edits = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!Array.isArray(edits) || edits.length > 16) throw new Error('Invalid research edit batch');
  return edits;
}
