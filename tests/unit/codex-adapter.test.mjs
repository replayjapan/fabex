import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginPartnerOperation,
  buildCheckpointSeed,
  completePartnerJob,
  completePartnerOperation,
  planThreadCall,
  threadRefreshAdvice,
  verifyResumedThread
} from '../../scripts/lib/codex-adapter.mjs';
import { initialState, initializeState, readState, updateState } from '../../scripts/lib/state.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-codex-'));
  const project = join(directory, 'project');
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { project, env: { ...process.env, FABEX_HOME: join(directory, 'data') } };
}

async function installFakeCompanion(directory, env, initialState) {
  const companionRoot = join(directory, 'companion');
  const script = join(companionRoot, 'scripts', 'codex-companion.mjs');
  const stateFile = join(directory, 'fake-companion-state.json');
  await mkdir(join(companionRoot, 'scripts'), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ next: 1, launches: [], commands: [], queue: [], jobs: {}, candidate: null, ...initialState }));
  await writeFile(script, `
import fs from 'node:fs';
const stateFile = process.env.FAKE_COMPANION_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const command = process.argv[2];
const args = process.argv.slice(3);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
state.commands.push({ command, args });
if (command === 'task') {
  const jobId = \`task-fake-\${state.next++}\`;
  const outcome = state.queue.shift() ?? { status: 'completed', threadId: 'thread-default', rawOutput: 'default output' };
  state.jobs[jobId] = { id: jobId, ...outcome };
  state.launches.push({ args, sessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null });
  save();
  process.stdout.write(JSON.stringify({ jobId, status: 'queued' }));
} else if (command === 'status') {
  const job = state.jobs[args.at(-1)];
  save();
  process.stdout.write(JSON.stringify({ job: { id: job.id, status: job.status }, waitTimedOut: false }));
} else if (command === 'result') {
  const job = state.jobs[args.at(-1)];
  const storedJob = { ...job };
  if (job.status === 'completed') {
    storedJob.result = { status: 0, threadId: job.threadId, rawOutput: job.rawOutput };
    state.candidate = { threadId: job.threadId };
  }
  save();
  process.stdout.write(JSON.stringify({ job: { id: job.id, status: job.status, errorMessage: job.errorMessage }, storedJob }));
} else if (command === 'task-resume-candidate') {
  save();
  process.stdout.write(JSON.stringify(state.candidatePayload ?? (state.candidate
    ? { available: true, sessionId: null, candidate: state.candidate }
    : { available: false, sessionId: null, candidate: null })));
} else {
  process.exitCode = 8;
}
`);
  env.FABEX_CODEX_PLUGIN_ROOT = companionRoot;
  env.FAKE_COMPANION_STATE = stateFile;
  return async () => JSON.parse(await readFile(stateFile, 'utf8'));
}

async function recordPrimaryThread(project, env, threadId) {
  await initializeState(project, env);
  const begun = await beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  await completePartnerOperation(project, begun.operationId, {
    threadId,
    fingerprint: { branch: 'main', head: 'abc', dirty: false }
  }, env);
}

test('thread plans allow only initial/boundary fresh and otherwise resume recorded ids', () => {
  const state = initialState({ projectId: '0000000000000000', canonicalRoot: '/synthetic/project' });
  const primary = planThreadCall(state, 'primary');
  assert.equal(primary.action, 'fresh');
  assert.equal(primary.companionFlag, '--fresh');
  assert.deepEqual(primary.checkpoint, state.partner.threads.checkpoint);
  const write = planThreadCall(state, 'write');
  assert.equal(write.action, 'fresh');
  assert.equal(write.reason, 'read-only-to-write-boundary');
  assert.equal(write.checkpoint, null);
  state.partner.threads.primaryThreadId = 'primary-1';
  state.partner.threads.writeThreadId = 'write-1';
  assert.equal(planThreadCall(state, 'primary').companionFlag, '--resume-last');
  assert.equal(planThreadCall(state, 'primary').expectedThreadId, 'primary-1');
  assert.equal(planThreadCall(state, 'write').expectedThreadId, 'write-1');
  const predictedMismatch = planThreadCall(state, 'primary', { checked: true, threadId: 'write-1' });
  assert.equal(predictedMismatch.action, 'recover');
  assert.equal(predictedMismatch.companionFlag, '--fresh');
  assert.equal(predictedMismatch.expectedThreadId, 'primary-1');
  assert.equal(predictedMismatch.predictedThreadId, 'write-1');
  assert.equal(predictedMismatch.reason, 'predicted-resume-thread-mismatch');
  const confirmedMissing = planThreadCall(state, 'write', { checked: true, threadId: null });
  assert.equal(confirmedMissing.action, 'recover');
  assert.equal(confirmedMissing.reason, 'confirmed-no-resume-candidate');
});

test('resume verification accepts the recorded id and fails closed on mismatch', () => {
  assert.equal(verifyResumedThread('thread-a', 'thread-a'), 'thread-a');
  assert.throws(() => verifyResumedThread('thread-a', 'thread-b'), (error) => error.code === 'thread-mismatch' && /pause and ask the owner/.test(error.message));
  assert.throws(() => verifyResumedThread('thread-a', null), /thread mismatch/);
});

test('checkpoint re-sync seed includes bounded continuity and stale-repo warning', () => {
  const seed = buildCheckpointSeed({
    ownerGoals: ['owner words verbatim'],
    acceptedDecisions: ['decision one'],
    currentStatus: 'tests passing'
  });
  assert.match(seed, /owner words verbatim/);
  assert.match(seed, /decision one/);
  assert.match(seed, /tests passing/);
  assert.match(seed, /earlier file observations are non-authoritative/);
});

test('companion calls serialize per workstream and write outcomes checkpoint', async (t) => {
  const { project, env } = await fixture(t);
  await initializeState(project, env);
  const begun = await beginPartnerOperation(project, {
    threadKind: 'write',
    envelope: { cwd: project, sandbox: 'workspace-write', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  await assert.rejects(beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env), /already running/);
  await completePartnerOperation(project, begun.operationId, {
    threadId: 'write-thread',
    currentStatus: 'bounded write outcome',
    acceptedDecisions: ['accepted'],
    fingerprint: { branch: 'main', head: 'abc', dirty: true }
  }, env);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.writeThreadId, 'write-thread');
  assert.equal(state.partner.threads.checkpoint.currentStatus, 'bounded write outcome');
  assert.deepEqual(state.partner.threads.checkpoint.acceptedDecisions, ['accepted']);
  assert.deepEqual(state.partner.threads.metadata.repoFingerprint, { branch: 'main', head: 'abc', dirty: true });
});

test('refresh advice surfaces long threads and substantial fingerprint movement', async (t) => {
  const { project, env } = await fixture(t);
  const initialized = await initializeState(project, env);
  await updateState(project, (state) => {
    state.partner.threads.metadata.turnCount = 40;
    state.partner.threads.metadata.repoFingerprint = { branch: 'main', head: 'abc', dirty: false };
    state.generation += 1;
    return state;
  }, { expectedGeneration: initialized.state.generation }, env);
  const threads = (await readState(project, env)).state.partner.threads;
  const advice = threadRefreshAdvice(threads, { branch: 'feature', head: 'def', dirty: false });
  assert.equal(advice.recommended, true);
  assert.deepEqual(advice.reasons, ['long-thread', 'repo-fingerprint-moved']);
});

test('background job completion resumes the recorded thread across repeated turns', async (t) => {
  const { project, env } = await fixture(t);
  const directory = join(project, '..');
  const readFake = await installFakeCompanion(directory, env, {
    candidate: { threadId: 'primary-thread' },
    jobs: {
      'task-resume-1': { id: 'task-resume-1', status: 'completed', threadId: 'primary-thread', rawOutput: 'turn one' },
      'task-resume-2': { id: 'task-resume-2', status: 'completed', threadId: 'primary-thread', rawOutput: 'turn two' }
    }
  });
  await recordPrimaryThread(project, env, 'primary-thread');
  for (const jobId of ['task-resume-1', 'task-resume-2']) {
    const begun = await beginPartnerOperation(project, {
      threadKind: 'primary',
      envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
    }, env);
    assert.equal(begun.plan.action, 'resume');
    const completed = await completePartnerJob(project, begun.operationId, jobId, env);
    assert.equal(completed.recovered, false);
    assert.equal(completed.threadId, 'primary-thread');
  }
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.primaryThreadId, 'primary-thread');
  assert.equal(state.partner.threads.metadata.turnCount, 3);
  assert.equal((await readFake()).launches.length, 0);
});

test('confirmed missing background thread creates one checkpoint-seeded atomic replacement', async (t) => {
  const { project, env } = await fixture(t);
  const directory = join(project, '..');
  const readFake = await installFakeCompanion(directory, env, {
    candidate: { threadId: 'stale-thread' },
    jobs: {
      'task-stale-1': {
        id: 'task-stale-1',
        status: 'failed',
        errorMessage: 'No previous Codex task thread was found for this repository.'
      }
    },
    queue: [{ status: 'completed', threadId: 'replacement-thread', rawOutput: 'recovered status' }]
  });
  await recordPrimaryThread(project, env, 'stale-thread');
  const before = await readState(project, env);
  await updateState(project, (state) => {
    state.partner.threads.checkpoint.ownerGoals = ['preserve this owner goal'];
    state.generation += 1;
    return state;
  }, { expectedGeneration: before.state.generation }, env);
  const begun = await beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  const completed = await completePartnerJob(project, begun.operationId, 'task-stale-1', env);
  assert.equal(completed.recovered, true);
  assert.equal(completed.recoveryReason, 'confirmed-missing-companion-thread');
  assert.equal(completed.replacedThreadId, 'stale-thread');
  assert.equal(completed.threadId, 'replacement-thread');
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.primaryThreadId, 'replacement-thread');
  assert.equal(state.operations.at(-1).externalId, 'replacement-thread');
  const fake = await readFake();
  assert.equal(fake.launches.length, 1);
  assert.ok(fake.launches[0].args.includes('--background'));
  assert.ok(fake.launches[0].args.includes('--fresh'));
  assert.equal(fake.launches[0].args.includes('--resume-last'), false);
  assert.match(fake.launches[0].args.at(-1), /preserve this owner goal/);
  assert.match(fake.launches[0].args.at(-1), /Visible Fabex continuity recovery/);
});

test('ambiguous companion failures remain fail-closed without fresh-thread recovery', async (t) => {
  const { project, env } = await fixture(t);
  const directory = join(project, '..');
  const readFake = await installFakeCompanion(directory, env, {
    candidate: { threadId: 'recorded-thread' },
    jobs: {
      'task-error-1': { id: 'task-error-1', status: 'failed', errorMessage: 'Companion task store could not be read.' }
    },
    queue: [{ status: 'completed', threadId: 'must-not-launch', rawOutput: 'unexpected' }]
  });
  await recordPrimaryThread(project, env, 'recorded-thread');
  const begun = await beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  await assert.rejects(completePartnerJob(project, begun.operationId, 'task-error-1', env), /did not complete successfully.*could not be read/i);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.primaryThreadId, 'recorded-thread');
  assert.equal(state.operations.at(-1).status, 'running');
  assert.equal((await readFake()).launches.length, 0);
});

test('ambiguous pre-launch resume inspection fails closed before recording or launching work', async (t) => {
  const { project, env } = await fixture(t);
  const directory = join(project, '..');
  const readFake = await installFakeCompanion(directory, env, {
    candidatePayload: { available: true, candidate: { threadId: null } }
  });
  await recordPrimaryThread(project, env, 'recorded-thread');
  await assert.rejects(beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env), /resume prediction returned an ambiguous candidate/);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.primaryThreadId, 'recorded-thread');
  assert.equal(state.operations.length, 1);
  assert.equal(state.operations[0].status, 'completed');
  assert.equal((await readFake()).launches.length, 0);
});

test('an unrelated returned thread is rejected and never adopted or replaced', async (t) => {
  const { project, env } = await fixture(t);
  const directory = join(project, '..');
  const readFake = await installFakeCompanion(directory, env, {
    candidate: { threadId: 'recorded-thread' },
    jobs: {
      'task-other-1': { id: 'task-other-1', status: 'completed', threadId: 'unrelated-thread', rawOutput: 'other context' }
    }
  });
  await recordPrimaryThread(project, env, 'recorded-thread');
  const begun = await beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  await assert.rejects(completePartnerJob(project, begun.operationId, 'task-other-1', env), /thread mismatch.*recorded recorded-thread.*unrelated-thread/i);
  const state = (await readState(project, env)).state;
  assert.equal(state.partner.threads.primaryThreadId, 'recorded-thread');
  assert.equal(state.operations.at(-1).status, 'running');
  assert.equal((await readFake()).launches.length, 0);
});

test('interleaved write completion predicts the sibling mismatch before any primary prompt launch', async (t) => {
  const { project, env } = await fixture(t);
  const directory = join(project, '..');
  const readFake = await installFakeCompanion(directory, env, {
    candidate: { threadId: 'primary-thread' },
    jobs: {
      'task-primary-1': { id: 'task-primary-1', status: 'completed', threadId: 'primary-thread', rawOutput: 'primary turn' },
      'task-write-1': { id: 'task-write-1', status: 'completed', threadId: 'write-thread', rawOutput: 'write turn' },
      'task-primary-2': { id: 'task-primary-2', status: 'completed', threadId: 'replacement-primary', rawOutput: 'replacement turn' },
      'task-primary-3': { id: 'task-primary-3', status: 'completed', threadId: 'replacement-primary', rawOutput: 'continued turn' }
    }
  });
  await recordPrimaryThread(project, env, 'primary-thread');

  const primary = await beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  assert.equal(primary.plan.action, 'resume');
  await completePartnerJob(project, primary.operationId, 'task-primary-1', env);

  const write = await beginPartnerOperation(project, {
    threadKind: 'write',
    envelope: { cwd: project, sandbox: 'workspace-write', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  assert.equal(write.plan.action, 'fresh');
  await completePartnerJob(project, write.operationId, 'task-write-1', env);

  const beforePrimaryRecovery = await readFake();
  assert.equal(beforePrimaryRecovery.candidate.threadId, 'write-thread');
  const recoveredPrimary = await beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  assert.equal(recoveredPrimary.plan.action, 'recover');
  assert.equal(recoveredPrimary.plan.companionFlag, '--fresh');
  assert.equal(recoveredPrimary.plan.expectedThreadId, 'primary-thread');
  assert.equal(recoveredPrimary.plan.predictedThreadId, 'write-thread');
  assert.match(recoveredPrimary.plan.seed, /Fabex continuity re-sync/);
  assert.equal((await readFake()).launches.length, 0, 'pre-launch prediction must not send a task prompt');

  const completedRecovery = await completePartnerJob(project, recoveredPrimary.operationId, 'task-primary-2', env);
  assert.equal(completedRecovery.recovered, true);
  assert.equal(completedRecovery.recoveryReason, 'prelaunch-resume-candidate-replacement');
  assert.equal(completedRecovery.replacedThreadId, 'primary-thread');
  assert.equal(completedRecovery.threadId, 'replacement-primary');
  assert.equal((await readState(project, env)).state.partner.threads.primaryThreadId, 'replacement-primary');

  const nextPrimary = await beginPartnerOperation(project, {
    threadKind: 'primary',
    envelope: { cwd: project, sandbox: 'read-only', approvalPolicy: 'native', instructionProfile: 'test' }
  }, env);
  assert.equal(nextPrimary.plan.action, 'resume');
  assert.equal(nextPrimary.plan.expectedThreadId, 'replacement-primary');
  const continued = await completePartnerJob(project, nextPrimary.operationId, 'task-primary-3', env);
  assert.equal(continued.recovered, false);
});
