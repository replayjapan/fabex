import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export class AttachmentValidationError extends Error {
  constructor(message, statuses) {
    super(`attachment validation failed; no operation queued: ${message}`);
    this.name = 'AttachmentValidationError';
    this.attachments = statuses;
  }
}

export function attachmentShape(paths = []) {
  if (!Array.isArray(paths) || paths.length > 6 || paths.some((path) => typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f]/.test(path) || !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(path).toLowerCase()))) throw new Error('attachments require at most 6 absolute png/jpg/jpeg/webp/gif paths');
  return paths;
}

// Explicit owner selection only. Do not scan arbitrary prose for file paths or
// remove these lines from the verbatim owner message used by digest verification.
export function selectedModeAttachments(message) {
  const paths = [];
  for (const line of (message ?? '').split(/\r?\n/)) {
    if (!/^attach:/.test(line)) continue;
    const path = line.slice('attach:'.length).trim();
    if (!path) throw new Error('attach: requires an absolute image path');
    paths.push(path);
  }
  return attachmentShape(paths);
}

const inside = (path, root) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); };
function permitted(path, pattern) {
  if (!isAbsolute(pattern)) return false;
  // Match directory components, never an unrestricted regex or a partial path.
  const parts = resolve(pattern).split('/');
  const actual = path.split('/');
  if (actual.length < parts.length) return false;
  return parts.every((part, index) => new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`).test(actual[index]));
}

export function validateAttachments(paths, root, config, { sessionId = '', env = process.env } = {}) {
  const uploads = resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'uploads');
  let realUploads = null;
  try { realUploads = realpathSync(uploads); } catch {}
  return attachmentShape(paths).map((path) => {
    const real = realpathSync(path);
    const rootReal = realpathSync(root);
    // Uploads have a stricter, session-scoped read policy even if a broader
    // workstream or scratch root would otherwise cover the Claude config dir.
    const isUpload = inside(resolve(path), uploads) || realUploads && inside(real, realUploads);
    let allowedUpload = false;
    if (isUpload && typeof sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(sessionId) && realUploads) {
      const sessionRoot = join(realUploads, sessionId);
      try {
        allowedUpload = realpathSync(join(uploads, sessionId)) === sessionRoot
          && (inside(resolve(path), join(uploads, sessionId)) || inside(resolve(path), sessionRoot)) && inside(real, sessionRoot);
      } catch {}
    }
    const allowed = isUpload ? allowedUpload : inside(real, rootReal) || (config?.guard?.externalWriteRoots ?? []).some((pattern) => {
      if (!pattern.includes('*')) { try { return inside(real, realpathSync(pattern)); } catch { return false; } }
      return permitted(real, pattern);
    });
    if (!allowed) throw new Error(isUpload ? 'upload attachment requires matching hook-recorded session evidence and must remain inside that session directory' : 'attachment is outside permitted roots (including resolved symlinks)');
    const info = statSync(real);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES || info.size === 0) throw new Error('attachment must be a nonempty regular image file no larger than 16 MiB');
    return real;
  });
}

export function validateSubmissionAttachments(paths, root, config, context) {
  const statuses = [];
  const resolved = [];
  try {
    attachmentShape(paths);
    for (const path of paths) {
      try {
        resolved.push(...validateAttachments([path], root, config, context));
        statuses.push({ path, status: 'selected' });
      } catch (error) {
        statuses.push({ path, status: 'failed' });
        throw error;
      }
    }
  } catch (error) {
    // All supplied paths are reported, but never send any subset on failure.
    for (const path of Array.isArray(paths) ? paths.slice(statuses.length, 6) : []) statuses.push({ path, status: 'failed' });
    throw new AttachmentValidationError(error.message, statuses);
  }
  return { paths: resolved, statuses };
}
