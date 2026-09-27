import { lstatSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

// Text documents may contain code examples; executable/configuration files do
// not become documents just because they are under a docs/ directory.
export function isDocumentationTarget(target, root) {
  if (typeof target !== 'string' || !target || /[\x00-\x1f]/.test(target)) return false;
  try {
    const base = realpathSync(root), path = resolve(base, target), rel = relative(base, path);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    if (parts.some(part => part.startsWith('.')) || ['AGENTS.MD', 'CLAUDE.MD', 'SKILL.MD'].includes(basename(path).toUpperCase())) return false;
    if (!['.md', '.markdown', '.txt', '.rst', '.adoc'].includes(extname(path).toLowerCase()) && !/^(README|LICENSE|CHANGELOG|HANDOFF|PLAN)$/i.test(basename(path))) return false;
    let current = base;
    for (const part of parts) {
      current = resolve(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || current === path && (!stat.isFile() || stat.nlink !== 1)) return false;
      } catch (error) { if (error.code !== 'ENOENT') return false; }
    }
    return true;
  } catch { return false; }
}

export function authorshipPolicy(values, plan) {
  const coder = values['roles.implementation.executor'];
  const docs = values['roles.docs.executor'];
  return {
    coder,
    codexDocuments: plan.role === 'docs' && ['codex', 'both'].includes(docs),
    claudeDocuments: plan.role === 'docs' && ['claude', 'both'].includes(docs),
    instructions: `Code editing belongs only to the selected Coding AI: ${coder}. This includes application code, test code, scripts and configuration. Other task assignments do not transfer code-editing authority. Documentation writer: ${docs}; documentation access permits handoffs, plans and other text documents, never source edits or runnable files placed in a docs folder. Both documentation writers can read and update the same existing document in turn. A non-coding partner reviews code and gives findings to the selected coder instead of applying a competing fix. Delegate code edits only to an explicitly owner-authorized sub-agent, within its recorded scope; do not invent an exception. These rules follow the selected roles, not a permanent restriction on either AI.`
  };
}
