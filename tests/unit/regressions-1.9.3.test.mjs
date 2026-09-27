import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeState, readState, updateState } from '../../scripts/lib/state.mjs';
import { beginHeavy, heavyStatus, heavyShape, finishHeavy, attachHeavyIdentity, releaseHeavy, recoverHeavy, runHeavy, wrappedHeavyInput, waitHeavy } from '../../scripts/lib/heavy.mjs';
import { sampleMemory } from '../../scripts/lib/memory.mjs';
import { changePrivate, sidecar, reclaimPrivateLock, readPrivate } from '../../scripts/lib/private-store.mjs';
import { recordOwnerPromptEvidence, resolveRecordedPrompt, textDigest } from '../../scripts/lib/hook-evidence.mjs';
import { recordSdkProcess, recoverSdkJobs, sdkLaunchOptions } from '../../scripts/lib/sdk-process.mjs';
import { recordToolCompletion } from '../../scripts/hook-heavy.mjs';
import { wakeMessage } from '../../scripts/hook-wake.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';

const normal = async () => ({ at: new Date().toISOString(), level: 'normal' });
const owned = { pid: 98761, pgid: 98761, signature: 'Mon Sep 14 10:00:00 2026|test-child' };
const dead = { identity: async () => null, members: async () => [], sample: normal };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fabex-193-')), root = join(dir, 'project');
  await mkdir(root); const env = { ...process.env, FABEX_HOME: join(dir, 'private') };
  t.after(() => rm(dir, { recursive: true, force: true }));
  await initializeState(root, env); return { root, env, dir };
}
const reserve = (root, env, id, extra = {}) => beginHeavy(root, { id, command: 'pnpm test', executor: 'test', ...extra }, env, { sample: normal });

test('1.9.3 recognizes workspace and runner shapes, rejects named parallel wrappers', async t => {
  const { root, env } = await fixture(t);
  for (const command of ['pnpm -w test', 'pnpm -r --filter app run build:ci', 'npm --workspace app run typecheck:ci', 'npx -y tsc --noEmit', 'pnpm exec eslint .', 'yarn dlx playwright test', 'pnpm exec next build', 'npm run e2e:ci']) assert.ok(heavyShape(command), command);
  for (const name of ['concurrently', 'npm-run-all']) {
    const result = await reserve(root, env, name, { command: `npx ${name} "pnpm test" "pnpm build"` });
    assert.equal(result.allowed, false); assert.match(result.reason, new RegExp(name));
  }
  assert.equal((await reserve(root, env, 'pipe', { command: 'pnpm test | pnpm build' })).allowed, false);
  assert.match((await reserve(root, env, 'chain', { command: 'pnpm test && npx concurrently "pnpm build" "pnpm lint"' })).reason, /concurrently/);
  assert.equal(heavyShape('rg "pnpm test" README.md'), null);
});
test('1.9.3 wrapper preserves tool fields and binds command/cwd before spawning', async t => {
  const { root, env } = await fixture(t);
  const input = { command: "pnpm test -- 'one two'", run_in_background: true, timeout: 5000 };
  const wrapped = wrappedHeavyInput(input, 'host:session:tool', '/plugin/scripts/control.mjs');
  assert.equal(wrapped.run_in_background, true); assert.equal(wrapped.timeout, 5000);
  assert.match(wrapped.command, /heavy run --id/); assert.match(wrapped.command, /one two/);
  await reserve(root, env, 'host:s:a', { wrapperRequested: true, cwd: root });
  await assert.rejects(runHeavy(root, 'host:s:a', 'pnpm build', env, { cwd: root }), /matching admitted/);
  let observedIdentity = false, options;
  const result = await runHeavy(root, 'host:s:a', 'pnpm test', env, {
    cwd: root, sample: normal, members: dead.members,
    spawnProcess: (file, args, opts) => {
      assert.equal(file, '/bin/bash'); assert.deepEqual(args, ['-c', 'pnpm test']); options = opts;
      const child = new EventEmitter(); child.pid = owned.pid; child.kill = () => {};
      setTimeout(async () => { observedIdentity = Boolean((await heavyStatus(root, env)).jobs[0]?.identity); child.emit('exit', 7, null); }, 100);
      return child;
    }, identity: async () => observedIdentity ? null : owned
  });
  assert.equal(observedIdentity, true); assert.equal(result.exitCode, 7); assert.equal(result.retained, false);
  assert.equal(options.cwd, root); assert.equal(options.env, env); assert.equal(options.stdio, 'inherit'); assert.equal(options.detached, true);
  assert.equal((await heavyStatus(root, env)).recovery.at(-1).exitCode, 7);
});
test('1.9.3 release refuses legacy, live, reused PID, nonempty group and unknown inspection', async t => {
  const { root, env } = await fixture(t);
  await reserve(root, env, 'legacy');
  await assert.rejects(releaseHeavy(root, 'legacy', env, dead), /release refused/);
  await attachHeavyIdentity(root, 'legacy', owned, env);
  for (const io of [{ ...dead, identity: async () => owned }, { ...dead, identity: async () => ({ ...owned, signature: 'reused' }) }, { ...dead, members: async () => [98762] }, { ...dead, identity: async () => { throw new Error('EPERM'); } }]) await assert.rejects(releaseHeavy(root, 'legacy', env, io), /release refused/);
  assert.equal(await releaseHeavy(root, 'legacy', env, dead), true);
});
test('1.9.3 an error after successful spawn cannot be treated as spawn-failure evidence', async t => {
  const { root, env } = await fixture(t);
  await reserve(root, env, 'host:s:error', { wrapperRequested: true, cwd: root });
  const result = await runHeavy(root, 'host:s:error', 'pnpm test', env, {
    cwd: root, sample: normal, identity: async () => owned, members: async () => [owned.pid],
    spawnProcess: () => {
      const child = new EventEmitter(); child.pid = owned.pid; child.kill = () => {};
      setTimeout(() => child.emit('error', new Error('signal permission denied')), 100);
      return child;
    }
  });
  assert.equal(result.retained, true);
  assert.equal((await heavyStatus(root, env)).jobs.length, 1);
});
test('1.9.3 owner-named recovery is audited, broad implementation authorization is not enough', async t => {
  const { root, env } = await fixture(t);
  await reserve(root, env, 'legacy');
  await recordOwnerPromptEvidence(root, { prompt: 'implement the repair', session_id: 's' }, env);
  await assert.rejects(recoverHeavy(root, 'legacy', env, { sample: normal }), /owner-named authorization/);
  await recordOwnerPromptEvidence(root, { prompt: 'recover heavy legacy', session_id: 's' }, env);
  assert.equal(await recoverHeavy(root, 'legacy', env, { sample: normal }), true);
  const state = (await readState(root, env)).state;
  assert.ok(state.partner.thread.checkpoint.acceptedDecisions.some(item => item.includes('legacy') && item.includes('no process signalled')));
});
test('1.9.3 host completion retains a known live group; missing wrapper uses exact tool completion', async t => {
  const { root, env } = await fixture(t);
  await reserve(root, env, 'host:s:a', { wrapperRequested: true });
  assert.match((await heavyStatus(root, env)).jobs[0].wrapperStatus, /unavailable/);
  await attachHeavyIdentity(root, 'host:s:a', owned, env);
  const input = { tool_name: 'Bash', tool_use_id: 'a', session_id: 's', hook_event_name: 'PostToolUseFailure', tool_input: {} };
  await recordToolCompletion(root, input, env, { ...dead, members: async () => [98762] });
  assert.equal((await heavyStatus(root, env)).jobs.length, 1);
  await recordToolCompletion(root, input, env, dead);
  assert.equal((await heavyStatus(root, env)).jobs.length, 0);
});
test('1.9.3 a recorded executor exception authorizes only its named reservation', async t => {
  const { root, env } = await fixture(t);
  await reserve(root, env, 'legacy');
  const authorize = async scope => {
    const result = await updateState(root, state => {
      state.executorException = { executor: 'claude-main', scope, reason: 'Explicit owner approval recorded for this stale reservation', authorizedAt: new Date().toISOString() };
      state.generation++; return state;
    }, {}, env);
    assert.equal(result.ok, true);
  };
  await authorize('recover-heavy:unrelated');
  await assert.rejects(recoverHeavy(root, 'legacy', env, { sample: normal }), /owner-named authorization/);
  await authorize('recover-heavy:legacy');
  assert.equal(await recoverHeavy(root, 'legacy', env, { sample: normal }), true);
});
test('1.9.3 SDK interruption retains unknown/live jobs and clears only verified dead groups', async t => {
  const { root, env } = await fixture(t), op = randomUUID();
  await reserve(root, env, `sdk:${op}:first`, { observed: true });
  assert.equal((await recoverSdkJobs(root, op, env, dead))[0].released, false);
  await recordSdkProcess(root, op, owned, env);
  assert.equal((await recoverSdkJobs(root, op, env, { ...dead, members: async () => [98762] }))[0].released, false);
  assert.equal((await recoverSdkJobs(root, op, env, dead))[0].released, true);
  const original = { config: { test: 'unchanged' } };
  assert.equal(sdkLaunchOptions(original, { root, operationId: op, env }, () => { throw new Error('unsupported'); }), original);
});
test('1.9.3 dead-owner lock reclamation preserves live/replacement and unknown locks', async t => {
  const { dir } = await fixture(t), lock = join(dir, 'sample.lock');
  await writeFile(lock, ''); assert.equal(await reclaimPrivateLock(lock, dead), false);
  const owner = { token: randomUUID(), identity: owned };
  await writeFile(lock, JSON.stringify(owner));
  assert.equal(await reclaimPrivateLock(lock, { identity: async () => owned }), false);
  assert.equal(await reclaimPrivateLock(lock, dead), true);
  const replacement = { token: randomUUID(), identity: owned };
  await writeFile(lock, JSON.stringify(replacement));
  assert.equal(await reclaimPrivateLock(lock, { identity: async () => owned }), false);
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), replacement);
});
test('1.9.3 memory sampling never holds the private lock and total timeout is unknown', async t => {
  const { root, env } = await fixture(t);
  await reserve(root, env, 'a', { command: 'pnpm test' });
  await finishHeavy(root, 'a', env, { sample: async () => { await changePrivate(root, 'heavy-jobs.json', {}, data => { data.probeOutsideLock = true; }, env); return normal(); } });
  const reading = await sampleMemory({ platform: 'darwin', timeoutMs: 15, execute: async () => new Promise(() => {}) });
  assert.equal(reading.level, 'unknown'); assert.match(reading.warning, /timed out/);
});
test('1.9.3 a replacement lock discovered during reclamation is preserved', async t => {
  const { dir } = await fixture(t), lock = join(dir, 'replacement.lock');
  await writeFile(lock, JSON.stringify({ token: randomUUID(), identity: owned }));
  const replacement = { token: randomUUID(), identity: { ...owned, pid: 98765 } };
  assert.equal(await reclaimPrivateLock(lock, { identity: async pid => {
    if (pid === owned.pid) await writeFile(lock, JSON.stringify(replacement));
    return null;
  } }), false);
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), replacement);
});
test('1.9.3 recovery survives death between lock publication and prepared-link cleanup', async t => {
  const { dir } = await fixture(t), lock = join(dir, 'published.lock'), prepared = join(dir, 'prepared');
  await writeFile(prepared, JSON.stringify({ token: randomUUID(), identity: owned }));
  await link(prepared, lock);
  await assert.rejects(readPrivate(lock, null), /unsafe/); // ordinary data still rejects aliases
  assert.equal(await reclaimPrivateLock(lock, dead), true);
  assert.equal(JSON.parse(await readFile(prepared, 'utf8')).identity.pid, owned.pid);
});
test('1.9.3 repeated waits remain available beyond the legacy quota and preserve review obligations', async t => {
  const { root, env } = await fixture(t);
  await updateState(root, s => { s.partner.thread.checkpoint.continuation.used = 20; s.generation++; return s; }, {}, env);
  for (let i = 0; i < 25; i++) assert.equal((await waitHeavy(root, 1, env, { sample: normal })).ready, true);
  const state = await readState(root, env);
  assert.equal(state.state.partner.thread.checkpoint.continuation.used, 20);
  // Review obligations remain independent of the retired counter.
  state.state.operations.push({ id: randomUUID(), status: 'queued', request: { phase: 'independent' }, result: {} });
  assert.equal(stopDecision({}, state).decision, 'block');
});
test('1.9.3 message resolution distinguishes references from substitutions; wake text is factual', async t => {
  const { root, env } = await fixture(t), text = 'Verify the approved work. ';
  await recordOwnerPromptEvidence(root, { prompt: text, session_id: 's' }, env);
  const state = (await readState(root, env)).state;
  assert.equal((await resolveRecordedPrompt(root, { ownerMessageDigest: textDigest(text) }, state, env)).resolution, 'recorded-by-digest');
  assert.equal((await resolveRecordedPrompt(root, { ownerMessageRef: 'latest' }, state, env)).resolution, 'recorded-latest');
  assert.equal((await resolveRecordedPrompt(root, { ownerMessage: text.trim() }, state, env)).resolution, 'substituted-recorded-original');
  assert.equal(wakeMessage({ phase: 'independent', status: 'completed' }), 'Fabex: Codex finished Phase 1; read the result.');
  assert.doesNotMatch(wakeMessage({ phase: 'reconcile', status: 'failed' }), /finished|reading/);
});
