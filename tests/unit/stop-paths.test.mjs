import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { dataRoot, resolveWorkstreamRoot } from '../../scripts/lib/paths.mjs';
import { initialState, initializeState } from '../../scripts/lib/state.mjs';
import { stopDecision } from '../../scripts/hook-stop.mjs';

function stateResult(operations = []) {
  const state = initialState({ projectId: '0000000000000000', canonicalRoot: '/synthetic/project' });
  state.operations = operations;
  return { ok: true, state, health: 'healthy' };
}

const running = { id: '11111111-1111-4111-8111-111111111111', kind: 'partner', name: 'codex', status: 'running', externalId: null };

test('Stop blocks only a running partner operation', () => {
  assert.deepEqual(stopDecision({}, { ok: false, health: 'corrupt' }), {});
  assert.deepEqual(stopDecision({}, stateResult()), {});
  assert.deepEqual(stopDecision({}, stateResult([{ ...running, status: 'completed' }])), {});
  assert.equal(stopDecision({}, stateResult([running])).decision, 'block');
  assert.deepEqual(stopDecision({ stop_hook_active: true }, stateResult([running])), {});
});

test('state data root is deterministic and has no release segment', () => {
  const expected = join(homedir(), '.claude', 'plugins', 'data', 'fabex');
  assert.equal(dataRoot({}), expected);
  assert.equal(dataRoot({ FABEX_HOME: './custom-fabex' }), resolve(homedir(), './custom-fabex'));
  assert.equal(/[/\\]v\d/.test(dataRoot({})), false);
});

test('session and guard source both call the shared payload-root helper', async () => {
  const pluginRoot = resolve(import.meta.dirname, '..', '..');
  for (const file of ['hook-session.mjs', 'hook-route-guard.mjs', 'hook-stop.mjs']) {
    const source = await readFile(resolve(pluginRoot, 'scripts', file), 'utf8');
    assert.match(source, /import \{[^}]*rootFromHookInput[^}]*\} from '\.\/lib\/paths\.mjs'/s, file);
    assert.match(source, /await rootFromHookInput\(input, process\.env\)/, file);
    assert.doesNotMatch(source, /input\.cwd \?\? process\.cwd\(\)/, file);
  }
});

test('root resolver uses invoked cwd only when no ancestor owns state', async (t) => {
  const { mkdtemp, mkdir, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'fabex-root-'));
  const nested = join(directory, 'one', 'two');
  await mkdir(nested, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  assert.equal(await resolveWorkstreamRoot(nested, env), await realpath(nested));
});

test('outer workstream state wins over an abandoned nested shadow state', async (t) => {
  const { mkdtemp, mkdir, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'fabex-root-shadow-'));
  const workstream = join(directory, 'workstream');
  const nested = join(workstream, 'packages', 'plugin');
  await mkdir(nested, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  await initializeState(workstream, env);
  await initializeState(nested, env);
  assert.equal(await resolveWorkstreamRoot(nested, env), await realpath(workstream));
});
