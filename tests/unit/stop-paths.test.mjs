import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { dataRoot } from '../../scripts/lib/paths.mjs';
import { initialState } from '../../scripts/lib/state.mjs';
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
    assert.match(source, /await rootFromHookInput\(input\)/, file);
    assert.doesNotMatch(source, /input\.cwd \?\? process\.cwd\(\)/, file);
  }
});
