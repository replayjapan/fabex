import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isTestTarget } from './authorship.mjs';
import { reviewSchema, validReview } from './review.mjs';

export const testEditInstructions = 'TEST WRITING: Your tools remain read-only and helper servers are disabled. Return your normal structured review plus testEdits, an array of at most 16 {path, expectedHash, content} records (256 KiB total). Paths are project-relative recognized test files only. expectedHash is the SHA-256 of the current file bytes, or null for a new file; content is the complete replacement text, or null to delete an existing test. Read existing files before proposing changes. The controller applies validated edits after the turn; describe them as proposed until application is confirmed. Never request broader application-code access. Test execution belongs to the separately selected Test Running agent after edits are applied.';
export function testEditSchema(phase) {
  const schema = reviewSchema(phase);
  schema.properties.testEdits = { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, expectedHash: { type: ['string', 'null'] }, content: { type: ['string', 'null'] } }, required: ['path', 'expectedHash', 'content'] } };
  schema.required.push('testEdits'); return schema;
}
const hash = data => createHash('sha256').update(data).digest('hex');
export function splitTestEdits(raw, phase) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 320 * 1024) throw new Error('Test edits response exceeds its bound; no tests changed.');
  const { testEdits, ...review } = JSON.parse(raw);
  if (!validReview(review, phase) || !Array.isArray(testEdits) || testEdits.length > 16 || Buffer.byteLength(JSON.stringify(testEdits)) > 256 * 1024) throw new Error('Invalid test edits response; no tests changed.');
  return { edits: testEdits, review: JSON.stringify(review) };
}
export function applyTestEdits(root, edits) {
  const seen = new Set();
  // Validate the entire batch before writing anything. The model has no filesystem
  // write access; this is the only test-writing path in a split Codex assignment.
  const batch = edits.map(edit => {
    if (!edit || Object.keys(edit).sort().join(',') !== 'content,expectedHash,path' || typeof edit.path !== 'string' || isAbsolute(edit.path) || edit.path.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || !isTestTarget(edit.path, root) || !(edit.content === null || typeof edit.content === 'string') || !(edit.expectedHash === null || /^[a-f0-9]{64}$/.test(edit.expectedHash))) throw new Error('Only recognized, unlinked project test files may be changed; no tests changed.');
    const path = resolve(root, edit.path);
    if (seen.has(path)) throw new Error('Duplicate test-edit target; no tests changed.'); seen.add(path);
    const old = existsSync(path) ? readFileSync(path) : null;
    if ((old === null ? null : hash(old)) !== edit.expectedHash || old === null && edit.content === null) throw new Error(`Test changed since it was read: ${edit.path}; no tests changed.`);
    return { ...edit, path, name: edit.path, old, mode: old === null ? 0o644 : statSync(path).mode & 0o777 };
  });
  const done = [];
  const install = (path, content, mode) => {
    if (content === null) { unlinkSync(path); return; }
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.fabex-${randomUUID()}`;
    try { writeFileSync(temp, content, { flag: 'wx', mode }); renameSync(temp, path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  };
  try {
    for (const item of batch) {
      if (!isTestTarget(item.path, root) || (existsSync(item.path) ? hash(readFileSync(item.path)) : null) !== item.expectedHash) throw new Error(`Test target changed during application: ${item.name}`);
      install(item.path, item.content, item.mode); done.push(item);
    }
  } catch (error) {
    const retained = [];
    for (const item of done.reverse()) {
      try {
        const current = existsSync(item.path) ? hash(readFileSync(item.path)) : null;
        if (!isTestTarget(item.path, root) || current !== (item.content === null ? null : hash(item.content))) throw new Error('concurrent change');
        install(item.path, item.old, item.mode);
      } catch { retained.push(item.name); }
    }
    throw new Error(`${error.message}; ${retained.length ? `could not roll back concurrently changed tests: ${retained.join(', ')}` : 'applied test edits rolled back'}`);
  }
  return batch.map(item => item.name);
}
