import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export function attachmentShape(paths = []) {
  if (!Array.isArray(paths) || paths.length > 6 || paths.some((path) => typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f]/.test(path) || !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(path).toLowerCase()))) throw new Error('attachments require at most 6 absolute png/jpg/jpeg/webp/gif paths');
  return paths;
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

export function validateAttachments(paths, root, config) {
  return attachmentShape(paths).map((path) => {
    const real = realpathSync(path);
    const rootReal = realpathSync(root);
    const allowed = inside(real, rootReal) || (config?.guard?.externalWriteRoots ?? []).some((pattern) => {
      if (!pattern.includes('*')) { try { return inside(real, realpathSync(pattern)); } catch { return false; } }
      return permitted(real, pattern);
    });
    if (!allowed) throw new Error('attachment is outside permitted roots (including resolved symlinks)');
    const info = statSync(real);
    if (!info.isFile() || info.size > 8 * 1024 * 1024 || info.size === 0) throw new Error('attachment must be a nonempty regular image file no larger than 8 MiB');
    return real;
  });
}
