import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatMode, formatModeTransition } from '../../scripts/lib/mode.mjs';
import { initializeState, updateState } from '../../scripts/lib/state.mjs';
import { renderStatusLine } from '../../scripts/status-line.mjs';

const matrix = [
  ['normal', 'both', 'work'],
  ['normal', 'claude', 'workClaude'],
  ['discussion', 'both', 'discussion'],
  ['discussion', 'claude', 'discussionClaude'],
  ['discussion', 'codex', 'discussionCodex'],
  ['ask-once', 'both', 'ask'],
  ['ask-once', 'claude', 'askClaude'],
  ['ask-once', 'codex', 'askCodex'],
  ['recovery-read-only', 'both', 'recovery-read-only']
];

test('shared formatter covers the canonical label matrix', () => {
  for (const [route, participants, label] of matrix) assert.equal(formatMode(route, participants), label);
  assert.throws(() => formatMode('normal', 'codex'), /invalid Fabex mode combination/);
  assert.equal(
    formatModeTransition({ route: 'discussion', participants: 'both' }, { route: 'discussion', participants: 'codex' }),
    'Fabex mode: discussion -> discussionCodex. Read-only; Codex participates.'
  );
});

test('status-line renderer is deterministic, read-only, and fail-closed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-status-line-'));
  const project = join(directory, 'project');
  const data = join(directory, 'data');
  const env = { ...process.env, FABEX_HOME: data };
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await renderStatusLine({ workspace: { current_dir: project } }, env), 'Fabex: state?');
  assert.deepEqual(await readdir(directory), ['project']);

  const initialized = await initializeState(project, env);
  await updateState(project, (state) => {
    state.route = 'discussion';
    state.participants = 'codex';
    state.generation += 1;
    return state;
  }, { expectedGeneration: initialized.state.generation }, env);
  const before = await readFile(initialized.paths.stateFile, 'utf8');
  assert.equal(await renderStatusLine({ cwd: project }, env), 'Fabex: discussionCodex · read-only');
  const entries = await readdir(initialized.paths.projectDir);
  assert.deepEqual(entries, ['state.json']);
  assert.equal(await readFile(initialized.paths.stateFile, 'utf8'), before);
});
