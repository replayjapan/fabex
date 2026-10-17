import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { researchRoot } from './policy.mjs';

// Validation is repeated by the child; the OS write boundary closes the gap
// between path validation and open/rename when another process swaps a link.
export function writePlan(root, platform = process.platform) {
  root = realpathSync(root);
  if (platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new Error('Contained planning/research writes require the macOS sandbox adapter on this host');
  const research = researchRoot(root), plans = join(root, 'Planning');
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(plans)}) (subpath ${JSON.stringify(research)}) (literal ${JSON.stringify(dirname(research))}))`;
  return { executable:'/usr/bin/sandbox-exec', args:['-p',profile,process.execPath,fileURLToPath(new URL('./edit-writer.mjs',import.meta.url)),root] };
}
export function applyContainedEdits(root, edits) {
  const plan = writePlan(root);
  const result = spawnSync(plan.executable, plan.args, { input:JSON.stringify(edits), encoding:'utf8', timeout:15000, maxBuffer:1024*1024,
    env:{PATH:'/usr/bin:/bin', HOME:researchRoot(realpathSync(root)), NODE_NO_WARNINGS:'1'} });
  if (result.status !== 0) throw new Error(`Contained edits failed: ${result.stderr?.trim() || result.error?.message || 'writer unavailable'}`);
  const written = JSON.parse(result.stdout);
  if (!Array.isArray(written) || written.some(p=>typeof p!=='string')) throw new Error('Invalid contained writer receipt');
  return written;
}
