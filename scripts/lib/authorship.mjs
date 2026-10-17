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

// A test-only grant is based on recognizable paths, never arbitrary file contents.
// Mixed application/test files and runner configuration remain Coding-owned.
export function isTestTarget(target, root) {
  if (typeof target !== 'string' || !target || /[\x00-\x1f]/.test(target)) return false;
  try {
    const base = realpathSync(root), path = resolve(base, target), rel = relative(base, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    const parts = rel.split(sep), name = basename(path), ext = extname(name).toLowerCase();
    if (parts.some(p => p.startsWith('.') || ['node_modules', 'vendor'].includes(p))) return false;
    if (/^(?:AGENTS|CLAUDE|SKILL)\.md$/i.test(name) || /(?:^|[._-])config\.[^.]+$/i.test(name) || /^(?:package(?:-lock)?\.json|conftest\.py|setup\.py|Cargo\.toml)$/i.test(name)) return false;
    const directory = parts.slice(0, -1).some(p => ['test', 'tests', '__tests__', 'spec', 'specs'].includes(p));
    const filename = /(?:[._-](?:test|spec)\.[^.]+$|^test_.+\.py$|_test\.go$|(?:Test|Tests)\.(?:java|cs|kt|swift)$)/.test(name);
    if (!(directory || filename) || !['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.rb', '.java', '.cs', '.kt', '.swift', '.c', '.cpp', '.h', '.php', '.snap'].includes(ext)) return false;
    let current = base;
    for (const part of parts) {
      current = resolve(current, part);
      try { const stat = lstatSync(current); if (stat.isSymbolicLink() || current === path && (!stat.isFile() || stat.nlink !== 1)) return false; }
      catch (error) { if (error.code !== 'ENOENT') return false; }
    }
    return true;
  } catch { return false; }
}

export function authorshipPolicy(values, plan) {
  const coder = values['roles.implementation.executor'];
  const testWriter = values['roles.testWriting.executor'];
  const testRunner = values['roles.testRunning.executor'];
  const docs = values['roles.docs.executor'];
  return {
    coder, testWriter, testRunner,
    codexTestEdits: plan.role === 'testWriting' && testWriter === 'codex' && coder !== 'codex',
    codexDocuments: plan.role === 'docs' && ['codex', 'both'].includes(docs),
    claudeDocuments: plan.role === 'docs' && ['claude', 'both'].includes(docs),
    instructions: `Application code, scripts and configuration belong to the selected Coding AI: ${coder}. Test Writing belongs to ${testWriter}; that agent may write recognized test files without gaining application-code access. Test Running belongs to ${testRunner}; use that assignment for test execution, not the writer assignment. Test files are source files in test/tests/__tests__/spec/specs directories or colocated .test/.spec files, test_*.py, *_test.go and *Test/*Tests class files. Symlinks, hard links, hidden/tooling paths and runner configuration are not test-write targets. Mixed application/test files remain Coding-owned. Documentation writer: ${docs}; documentation access permits text handoffs and plans, never source or runnable files. Both documentation writers may update the same document in turn. A partner without the relevant assignment reviews and gives findings to the assigned writer instead of making competing edits. Delegate code edits only to an explicitly owner-authorized sub-agent within its recorded scope. Do not bypass these boundaries through shell scripts or MCP. These rules follow effective conversation/milestone/project settings, not a permanent AI identity.`
  };
}
