#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootFromControlCwd } from './lib/paths.mjs';
import { assertUuid, ValidationError } from './lib/validation.mjs';
import { cancelOperation, claimNextOperation, claimRunner, operationStatus, releaseRunner, releaseRunnerIfIdle, runOperation, submitOperation } from './lib/sdk-controller.mjs';
import { relayBlock } from './lib/review.mjs';

async function codexFactory(options) {
  const { Codex } = await import('@openai/codex-sdk');
  return new Codex(options);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length || args.indexOf(name, index + 1) !== -1) throw new ValidationError(`${name} is required exactly once`);
  return args[index + 1];
}

const terminal = (status) => ['completed', 'failed', 'cancelled'].includes(status);
const boundedStatus = (result) => ({ id: result.id, status: result.status, externalId: result.externalId, phase: result.request?.phase, parentOperationId: result.request?.parentOperationId, lifecycle: result.lifecycle, usage: result.usage ?? null, attachments: result.result?.attachments ?? null });
const USAGE = 'Usage: controller.mjs submit < envelope.json | status|result|cancel --operation-id <uuid> | relay --operation-id <uuid> [--full] | wait --operation-id <uuid> --timeout <1..120>';

export async function waitForOperation(root, operationId, timeoutSeconds, env = process.env, pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds))) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 120) throw new ValidationError('wait timeout must be positive and at most 120 seconds');
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastOperation = null;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { operation: lastOperation ?? {
      id: operationId,
      status: 'working',
      externalId: null,
      lifecycle: { phase: 'working', detail: 'Wait timed out before state became readable.', queuedAt: null, startedAt: null, finishedAt: null, cancelRequested: false }
    }, timedOut: true };
    try {
      const operation = await operationStatus(root, operationId, env, { lockWaitMs: Math.min(400, remaining), pause });
      lastOperation = boundedStatus(operation);
      if (terminal(operation.status)) return { operation: lastOperation, timedOut: false };
    } catch (error) {
      if (!['lock-contention', 'migration-deferred'].includes(error?.code)) throw error;
    }
    const afterRead = deadline - Date.now();
    if (afterRead <= 0) continue;
    await pause(Math.min(1000, afterRead));
  }
}

async function stdinMessage() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 192 * 1024 + 1) throw new ValidationError('stdin owner message exceeds 192 KiB');
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString('utf8');
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

export async function runQueue(root, env = process.env, createCodex = codexFactory) {
  if (!(await claimRunner(root, process.pid, env))) return;
  let activeController = null;
  const abort = () => activeController?.abort();
  process.on('SIGUSR1', abort);
  try {
    while (true) {
      const operation = await claimNextOperation(root, env);
      if (!operation) {
        if (await releaseRunnerIfIdle(root, process.pid, env)) break;
        continue;
      }
      activeController = new AbortController();
      try { await runOperation(root, operation, { createCodex, signal: activeController.signal }, env); } catch {}
      activeController = null;
    }
  } finally {
    process.off('SIGUSR1', abort);
    await releaseRunner(root, process.pid, env).catch(() => {});
  }
}

export async function main({ cwd = process.cwd(), argv = process.argv.slice(2), env = process.env } = {}) {
  const [command, ...args] = argv;
  if ((command === '--help' && args.length === 0) || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === 'runner') {
    if (args.length !== 2 || args[0] !== '--root') throw new ValidationError('runner requires exactly --root <path>');
    return runQueue(resolve(args[1]), env);
  }
  const root = await rootFromControlCwd(cwd, env);
  if (command === 'submit') {
    const message = args.length === 0 ? await stdinMessage() : args.length === 2 && args[0] === '--message' ? args[1] : null;
    if (message === null) throw new ValidationError('submit accepts stdin or exactly --message <owner-message>');
    process.stdout.write(`${JSON.stringify(await submitOperation(root, message, env))}\n`);
    return;
  }
  if (['status', 'result', 'relay', 'cancel'].includes(command)) {
    const full = command === 'relay' && args.length === 3 && args[2] === '--full';
    if ((!full && args.length !== 2) || args[0] !== '--operation-id') throw new ValidationError(`${command} requires --operation-id <uuid>${command === 'relay' ? ' [--full]' : ''}`);
    const id = assertUuid(option(args, '--operation-id'), 'operation id');
    let result = command === 'cancel' ? await cancelOperation(root, id, env) : await operationStatus(root, id, env);
    if (command === 'relay') {
      const block = terminal(result.status) && relayBlock(result, { full });
      if (!block) throw new Error('operation has no complete relay block');
      process.stdout.write(`${block}\n`);
      return;
    }
    if (command === 'result' && !terminal(result.status)) throw new Error('operation is not complete');
    if (command === 'result') result = { ...result, relayBlock: relayBlock(result) };
    if (command === 'status') result = boundedStatus(result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'wait') {
    if (args.length !== 4 || args[0] !== '--operation-id' || args[2] !== '--timeout') throw new ValidationError('wait requires exactly --operation-id <uuid> --timeout <seconds>');
    const id = assertUuid(args[1], 'operation id');
    if (!/^\d+$/.test(args[3]) || Number(args[3]) < 1 || Number(args[3]) > 120) throw new ValidationError('wait timeout must be an integer from 1 to 120 seconds');
    const waited = await waitForOperation(root, id, Number(args[3]), env);
    process.stdout.write(`${JSON.stringify(waited.operation, null, 2)}\n`);
    if (waited.timedOut) process.exitCode = 3;
    return;
  }
  throw new ValidationError(`unknown or malformed controller command\n${USAGE}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    if (error.attachments) process.stdout.write(`${JSON.stringify({ status: 'failed', operationId: null, attachments: error.attachments, error: error.message })}\n`);
    process.stderr.write(`fabex-controller: ${error.message}\n`);
    process.exitCode = 1;
  }
}
