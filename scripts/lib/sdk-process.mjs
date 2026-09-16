import { createRequire } from 'node:module';
import { dirname, join, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changePrivate } from './private-store.mjs';
import { heavyStatus, releaseHeavy } from './heavy.mjs';

// Resolve the pinned SDK dependency, never an unrelated `codex` from PATH.
// Supports the two package layouts shipped by that dependency. Unknown layouts
// retain the normal SDK launcher and leave interrupted ownership unknown.
export function sdkLaunchOptions(options, { root, operationId, env = process.env }, resolveSdk = () => import.meta.resolve('@openai/codex-sdk')) {
  try {
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
    const suffix = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'linux' ? 'unknown-linux-musl' : null;
    if (!arch || !suffix) return options;
    const sdkRequire = createRequire(resolveSdk());
    const req = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
    const platform = req.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const base = join(dirname(platform), 'vendor', `${arch}-${suffix}`);
    const modern = existsSync(join(base, 'codex-package.json')) && existsSync(join(base, 'bin', 'codex'));
    const binary = join(base, modern ? 'bin' : 'codex', 'codex');
    if (!existsSync(binary)) return options;
    const tools = join(base, modern ? 'codex-path' : 'path');
    return { ...options, codexPathOverride: fileURLToPath(new URL('../sdk-process.mjs', import.meta.url)), env: {
      ...env, ...(existsSync(tools) ? { PATH: `${tools}${delimiter}${env.PATH ?? ''}` } : {}),
      FABEX_SDK_BINARY: binary, FABEX_SDK_ROOT: root, FABEX_SDK_OPERATION: operationId
    } };
  } catch { return options; }
}
export async function recordSdkProcess(root, operationId, identity, env = process.env) {
  return changePrivate(root, 'heavy-jobs.json', { jobs: [], samples: [] }, data => {
    data.sdkProcesses = [...(data.sdkProcesses ?? []).filter(item => item.operationId !== operationId), { operationId, identity }].slice(-16);
    for (const job of data.jobs) if (job.id.startsWith(`sdk:${operationId}:`) && !job.identity) job.identity = identity;
  }, env);
}
export async function recoverSdkJobs(root, operationId, env = process.env, dependencies = {}) {
  const outcomes = [];
  for (const job of (await heavyStatus(root, env)).jobs.filter(item => item.id.startsWith(`sdk:${operationId}:`))) {
    try { outcomes.push({ id: job.id, released: await releaseHeavy(root, job.id, env, dependencies) }); }
    catch { outcomes.push({ id: job.id, released: false }); }
  }
  return outcomes;
}
