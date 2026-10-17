#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { processIdentity, sameIdentity } from './lib/process-evidence.mjs';
import { recordSdkProcess, recoverSdkJobs } from './lib/sdk-process.mjs';

const root = process.env.FABEX_SDK_ROOT, operationId = process.env.FABEX_SDK_OPERATION;
const binary = process.env.FABEX_SDK_BINARY;
if (!root || !/^[0-9a-f-]{36}$/.test(operationId ?? '') || !binary?.startsWith('/')) throw new Error('invalid SDK launch envelope');
const env = { ...process.env };
for (const name of ['FABEX_SDK_ROOT', 'FABEX_SDK_OPERATION', 'FABEX_SDK_BINARY']) delete env[name];
const child = spawn(binary, process.argv.slice(2), { env, detached: true, stdio: 'inherit' });
const done = new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1)); });
let identity = null;
try {
  identity = await processIdentity(child.pid);
  if (identity?.pgid === child.pid) await recordSdkProcess(root, operationId, identity);
} catch { /* Never invent identity when the host prohibits inspection. */ }
const forward = async signal => {
  try {
    if (identity && sameIdentity(identity, await processIdentity(child.pid))) process.kill(-identity.pgid, signal);
    else child.kill(signal);
  } catch {}
};
process.on('SIGTERM', () => void forward('SIGTERM'));
process.on('SIGINT', () => void forward('SIGINT'));
const code = await done;
await recoverSdkJobs(root, operationId).catch(() => {});
process.exitCode = code;
