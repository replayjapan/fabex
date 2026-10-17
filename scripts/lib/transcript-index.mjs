import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { changePrivate, readPrivate, sidecar } from './private-store.mjs';

// Extract only a top-level record discriminator from a bounded prefix. Large
// compaction records may embed an entire replacement history; never buffer it.
function recordType(prefix) {
  let depth = 0, quoted = false, escaped = false, token = '', key = null, expectValue = false;
  for (const c of prefix.toString('utf8')) {
    if (quoted) {
      if (escaped) { token += '\\' + c; escaped = false; }
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        quoted = false;
        if (depth === 1) {
          if (expectValue && key === 'type') { try { return JSON.parse('"' + token + '"'); } catch { return null; } }
          if (!expectValue) key = token;
        }
      } else if (token.length < 256) token += c;
    } else if (c === '"') { quoted = true; token = ''; }
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 1 && c === ':') expectValue = true;
    else if (depth === 1 && c === ',') { expectValue = false; key = null; }
  }
  return null;
}

// Parse complete JSONL records with bounded buffers, including oversized tool
// records which are skipped rather than retained. Offsets end at a newline.
export async function scanRecords(file, { offset = 0, onRecord, milliseconds = Infinity } = {}) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw new Error('not a transcript file');
    const deadline = Date.now() + milliseconds, buffer = Buffer.alloc(64 * 1024);
    let position = offset, committed = offset, pieces = [], length = 0, oversized = false, skippedRecords = 0, oversizedType = null;
    while (position < stat.size && Date.now() < deadline) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) break;
      let start = 0;
      for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10) {
        const part = buffer.subarray(start, i); length += part.length;
        if (!oversized && length <= 1024 * 1024) {
          pieces.push(Buffer.from(part));
          try { onRecord(JSON.parse(Buffer.concat(pieces).toString('utf8'))); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        } else {
          const type = oversizedType ?? recordType(Buffer.concat(pieces));
          if (type) onRecord({ type, oversized: true }); else skippedRecords++;
        }
        committed = position + i + 1; pieces = []; length = 0; oversized = false; oversizedType = null; start = i + 1;
      }
      const rest = buffer.subarray(start, bytesRead); length += rest.length;
      if (length > 1024 * 1024) { if (!oversized) oversizedType = recordType(Buffer.concat(pieces)); oversized = true; pieces = []; }
      else if (!oversized) pieces.push(Buffer.from(rest));
      position += bytesRead;
    }
    return { offset: committed, scannedToEnd: position === stat.size, skippedRecords, size: stat.size, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` };
  } finally { await handle.close(); }
}

export async function fullTitle(file, sessionId) {
  let title = null;
  await scanRecords(file, { onRecord: v => {
    if (v.type === 'custom-title' && v.sessionId === sessionId && typeof v.customTitle === 'string' && v.customTitle.trim()) title = v.customTitle.trim().slice(0, 200);
  } });
  return title;
}

async function fingerprint(file, offset = 0) {
  const handle = await open(file, 'r');
  try {
    const s = await handle.stat(), length = Math.min(256, offset || s.size);
    const b = Buffer.alloc(length); await handle.read(b, 0, length, offset ? Math.max(0, offset - length) : 0);
    return { identity: `${s.dev}:${s.ino}:${s.birthtimeMs}`, size: s.size, hash: createHash('sha256').update(b).digest('hex') };
  } finally { await handle.close(); }
}

export async function indexedGauge(root, file, env, { milliseconds = 2000 } = {}) {
  const key = createHash('sha256').update('record-index-v2:' + file).digest('hex');
  const cache = await readPrivate(await sidecar(root, 'transcript-index.json', env), { entries: {} });
  let prior = cache.entries[key];
  const fp = await fingerprint(file, prior?.offset ?? 0);
  if (!prior || prior.identity !== fp.identity || fp.size < prior.offset || prior.anchor !== fp.hash) prior = { offset: 0, compactions: 0, lastCall: null };
  const value = { ...prior };
  const result = await scanRecords(file, { offset: prior.offset, milliseconds, onRecord: v => {
    if (v.type === 'compacted') value.compactions++;
    const info = v.payload?.info;
    if (v.payload?.type === 'token_count' && Number.isFinite(info?.last_token_usage?.input_tokens) && info.model_context_window > 0)
      value.lastCall = { inputTokens: info.last_token_usage.input_tokens, windowTokens: info.model_context_window, at: v.timestamp, fraction: info.last_token_usage.input_tokens / info.model_context_window };
  } });
  const anchor = await fingerprint(file, result.offset);
  if (anchor.identity !== result.identity || anchor.size < result.offset) throw new Error('transcript changed during scan; retry');
  Object.assign(value, result, { skippedRecords: (prior.skippedRecords ?? 0) + result.skippedRecords, anchor: anchor.hash, updatedAt: Date.now() });
  let cacheWarning = null;
  try { await changePrivate(root, 'transcript-index.json', { entries: {} }, data => {
    const existing = data.entries[key];
    if (!existing || existing.updatedAt <= (cache.entries[key]?.updatedAt ?? 0)) data.entries[key] = value;
    for (const [id] of Object.entries(data.entries).sort((a,b) => b[1].updatedAt-a[1].updatedAt).slice(128)) delete data.entries[id];
  }, env); } catch { cacheWarning = 'Index could not be persisted; next read may rescan. Snapshot remains bounded.'; }
  return { available: Boolean(value.lastCall), lastCall: value.lastCall, compactions: value.compactions,
    compactionCountCoverage: value.skippedRecords ? 'partial coverage: oversized records skipped' : result.scannedToEnd ? 'whole file, complete records through sampled end' : 'partial scan; counting continues on next read',
    cacheWarning,
    scannedBytes: result.offset, fileBytes: result.size, source: 'local rollout metadata; not live occupancy' };
}
