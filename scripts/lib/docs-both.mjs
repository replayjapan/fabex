import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';
import { changePrivate, readPrivate, sidecar } from './private-store.mjs';
import { readState } from './state.mjs';
import { loadEffectiveConfig } from './config.mjs';
import { executionPlan } from './workspace-settings.mjs';
const LIMIT = 256 * 1024;
function draftFile(id) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid documentation operation.');
  // Letters-only private filenames; one bounded record per cycle, no project quota.
  return 'documentation-' + [...id.replaceAll('-', '')].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('') + '.json';
}
const hash = text => createHash('sha256').update(text).digest('hex');
export async function documentationJob(root, id, env = process.env) {
  return (await readPrivate(await sidecar(root, draftFile(id), env), { jobs: {} }, LIMIT)).jobs[id] ?? null;
}
async function context(root, id, env) {
  const current = await readState(root, env); if (!current.ok) throw new Error('Documentation state unavailable.');
  const s = current.state, op = s.operations.find(o => o.id === id);
  if (!op || op.request.phase !== 'independent' || op.request.participants !== 'both' || op.request.route !== 'normal' || op.request.sandbox !== 'workspace-write') throw new Error('Docs Both requires an authorized work cycle with both partners.');
  const sessionId = op.result.relay?.sessionId;
  if (s.route !== 'normal' || s.workspace.activeSessionId !== sessionId) throw new Error('Documentation requires the originating work session.');
  const plan = executionPlan((await loadEffectiveConfig(root, env)).config, s, sessionId);
  if (plan.role !== 'docs' || plan.executor !== 'both') throw new Error('Select the Documentation task with Both before starting its cycle.');
  const sdk = env.FABEX_DOCUMENTATION_OPERATION;
  const running = sdk && s.operations.find(o => o.id === sdk);
  if (sdk && (!running || running.status !== 'working' || s.controller.activeOperationId !== sdk || running.id !== id && running.request.parentOperationId !== id)) throw new Error('Codex draft requires its active documentation operation.');
  return { s, op, author: sdk ? 'codex' : 'claude', running };
}
async function target(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || !name.endsWith('.md') || name.split(/[\\/]/).some(p => !p || p === '..' || p.startsWith('.'))) throw new Error('Choose a Markdown file inside the project, outside hidden folders.');
  const base = await realpath(root), path = resolve(base, name), parent = await realpath(dirname(path));
  if (parent !== dirname(path) || relative(base, path).startsWith('..')) throw new Error('Documentation paths cannot traverse links or leave the project.');
  let text = null;
  try {
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const st = await h.stat(); if (!st.isFile() || st.nlink !== 1 || st.size > 128 * 1024) throw new Error('Unsafe documentation target.'); text = await h.readFile('utf8'); } finally { await h.close(); }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { path, text };
}
export async function saveDocumentationDraft(root, id, payload, env = process.env) {
  const { s, op, author, running } = await context(root, id, env);
  if (!payload || typeof payload.body !== 'string' || !payload.body.trim() || Buffer.byteLength(payload.body) > 32768) throw new Error('Each author’s contribution must be 1–32768 bytes.');
  const before = await documentationJob(root, id, env);
  const revising = op.status === 'completed';
  if (author === 'claude' && (s.controller.activeOperationId || (!revising && (op.status !== 'queued' || s.workspace.seals[id]?.reading)))) throw new Error('Claude must save its independent draft before sealing; later revisions require an idle review boundary.');
  if (author === 'codex' && (!before?.sealed || running.request.phase === 'independent' && before.codex)) throw new Error('Codex’s independent draft is written once, after Claude’s draft is sealed.');
  if (revising && !before?.codex) throw new Error('Both independent drafts must exist before revision.');
  const initial = !before ? await target(root, payload.path) : null;
  // Do not replace an unrelated document with two sections as a side effect.
  if (initial?.text !== null && initial) throw new Error('Choose a new output document; existing files are preserved.');
  return changePrivate(root, draftFile(id), { jobs: {} }, store => {
    let job = store.jobs[id];
    if (!job) {
      if (author !== 'claude') throw new Error('Claude starts the independent documentation cycle.');
      job = store.jobs[id] = { path: payload.path, sessionId: op.result.relay.sessionId, claude: null, codex: null, original: {}, assembledHash: null };
    }
    if (author === 'claude' && !revising && job.sealed) throw new Error('Claude’s independent draft is sealed.');
    if (payload.path && payload.path !== job.path) throw new Error('A draft cannot change the other author’s output target.');
    job[author] = payload.body;
    if (!revising) job.original[author] = { body: payload.body, hash: hash(payload.body) };
    return { saved: true, author, operationId: id, independent: !revising, digest: hash(payload.body) };
  }, env, LIMIT);
}
export async function readDocumentationDrafts(root, id, env = process.env) {
  const { op, author } = await context(root, id, env), job = await documentationJob(root, id, env);
  if (!job) throw new Error('No documentation draft recorded.');
  if (op.status !== 'completed' || !job.claude || !job.codex) return { path: job.path, author, body: job[author], other: 'Hidden until both independent contributions are complete.' };
  return { path: job.path, claude: job.claude, codex: job.codex };
}
export async function sealDocumentationDraft(root, operation, env = process.env) {
  return changePrivate(root, draftFile(operation.id), { jobs: {} }, store => {
    const job = store.jobs[operation.id];
    if (!job?.claude) throw new Error('Claude must save its independent documentation draft before sealing this cycle.');
    job.sealed = true;
  }, env, LIMIT);
}
export async function requireDocumentationDraft(root, operation, env = process.env, { completed = false } = {}) {
  const job = await documentationJob(root, operation.request.parentOperationId ?? operation.id, env);
  if (!job?.claude || !job.sealed || completed && !job.codex) throw new Error(completed ? 'Docs Both has no Codex contribution; preserve work and complete the separate draft.' : 'Claude must save its independent documentation draft before sealing this cycle.');
  return job;
}
export async function assembleDocumentation(root, id, reviewId, env = process.env) {
  const { s, author } = await context(root, id, env);
  if (author !== 'claude' || s.controller.activeOperationId) throw new Error('Assembly requires the originating Claude session after review.');
  const review = s.operations.find(o => o.id === reviewId);
  if (review?.status !== 'completed' || review.request.phase !== 'reconcile' || review.request.parentOperationId !== id) throw new Error('Assembly requires the completed matching review.');
  return changePrivate(root, draftFile(id), { jobs: {} }, async store => {
    const job = store.jobs[id]; if (!job?.claude || !job.codex) throw new Error('Both contributions are required.');
    for (const author of ['claude', 'codex']) if (hash(job.original[author].body) !== job.original[author].hash) throw new Error('Independent draft integrity check failed.');
    const output = `# Claude\n\n${job.claude}\n\n# Codex\n\n${job.codex}\n`;
    const { path, text } = await target(root, job.path);
    if (text !== null && hash(text) !== job.assembledHash) throw new Error('The document changed outside assembly; nothing was overwritten.');
    const temp = join(dirname(path), `.fabex-docs-${randomUUID()}`);
    try {
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(output); await handle.sync(); } finally { await handle.close(); }
      // Recheck immediately before replacement; do not follow target symlinks.
      const latest = await target(root, job.path);
      if (latest.text !== text) throw new Error('Document changed during assembly.');
      await rename(temp, path); job.assembledHash = hash(output); job.reviewId = reviewId;
    } finally { await unlink(temp).catch(() => {}); }
    return { assembled: true, path: job.path, claudeDigest: hash(job.claude), codexDigest: hash(job.codex) };
  }, env, LIMIT);
}
