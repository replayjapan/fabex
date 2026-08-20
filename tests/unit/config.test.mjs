import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-config-'));
  const root = join(directory, 'project');
  const data = join(directory, 'data');
  await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { root, data, env: { ...process.env, FABEX_HOME: data } };
}

test('shipped defaults load without configuration', async (t) => {
  const { root, data, env } = await fixture(t);
  const result = await loadEffectiveConfig(root, env);
  assert.deepEqual(result.config, {
    schemaVersion: 1,
    models: { codex: { model: null, reasoningEffort: 'high' }, operational: 'sonnet' },
    collaboration: { jointByDefault: true },
    display: { replyModeBadge: 'always' }
  });
  assert.equal(result.sources.shippedLoaded, true);
  assert.equal(result.sources.machine, join(data, 'config.json'));
  assert.equal(result.sources.machineLoaded, false);
  assert.equal(result.sources.projectLoaded, false);
  assert.deepEqual(result.warnings, []);
});

test('project fields override machine fields without replacing siblings', async (t) => {
  const { root, data, env } = await fixture(t);
  await mkdir(data);
  await writeFile(join(data, 'config.json'), JSON.stringify({
    models: { codex: { model: 'gpt-machine', reasoningEffort: 'low' }, operational: 'haiku' },
    collaboration: { jointByDefault: false }
  }));
  await mkdir(join(root, '.fabex'));
  await writeFile(join(root, '.fabex', 'config.json'), JSON.stringify({ models: { codex: { reasoningEffort: 'xhigh' } } }));
  const result = await loadEffectiveConfig(root, env);
  assert.deepEqual(result.config.models.codex, { model: 'gpt-machine', reasoningEffort: 'xhigh' });
  assert.equal(result.config.models.operational, 'haiku');
  assert.equal(result.config.collaboration.jointByDefault, false);
  assert.equal(result.sources.machineLoaded, true);
  assert.equal(result.sources.projectLoaded, true);
});

test('unknown reasoning effort passes through with a warning', async (t) => {
  const { root, env } = await fixture(t);
  await mkdir(join(root, '.fabex'));
  await writeFile(join(root, '.fabex', 'config.json'), JSON.stringify({ models: { codex: { reasoningEffort: 'ultra' } } }));
  const result = await loadEffectiveConfig(root, env);
  assert.equal(result.config.models.codex.reasoningEffort, 'ultra');
  assert.match(result.warnings.join('\n'), /unknown and was passed through/);
});

test('unsupported schemaVersion ignores the whole layer', async (t) => {
  const { root, data, env } = await fixture(t);
  await mkdir(data);
  await writeFile(join(data, 'config.json'), JSON.stringify({ models: { operational: 'haiku' } }));
  await mkdir(join(root, '.fabex'));
  await writeFile(join(root, '.fabex', 'config.json'), JSON.stringify({ schemaVersion: 2, models: { operational: 'opus' }, collaboration: { jointByDefault: false } }));
  const result = await loadEffectiveConfig(root, env);
  assert.equal(result.config.models.operational, 'haiku');
  assert.equal(result.config.collaboration.jointByDefault, true);
  assert.match(result.warnings.join('\n'), /unsupported schemaVersion 2; the entire layer was ignored/);
});

test('invalid fields fall back independently and removed claudePrimary is named', async (t) => {
  const { root, env } = await fixture(t);
  await mkdir(join(root, '.fabex'));
  await writeFile(join(root, '.fabex', 'config.json'), JSON.stringify({
    models: { claudePrimary: 'ignored', codex: { model: 'bad model' }, operational: '', extra: true },
    collaboration: { jointByDefault: 'yes' }
  }));
  const result = await loadEffectiveConfig(root, env);
  assert.equal(result.config.models.codex.model, null);
  assert.equal(result.config.models.operational, 'sonnet');
  assert.equal(result.config.collaboration.jointByDefault, true);
  assert.match(result.warnings.join('\n'), /models\.claudePrimary was removed and was ignored/);
  assert.match(result.warnings.join('\n'), /unknown config key models.extra/);
});

test('malformed project JSON preserves lower layers and reports loaded false', async (t) => {
  const { root, data, env } = await fixture(t);
  await mkdir(data);
  await writeFile(join(data, 'config.json'), JSON.stringify({ models: { operational: 'haiku' } }));
  await mkdir(join(root, '.fabex'));
  await writeFile(join(root, '.fabex', 'config.json'), '{');
  const result = await loadEffectiveConfig(root, env);
  assert.equal(result.config.models.operational, 'haiku');
  assert.equal(result.sources.projectLoaded, false);
  assert.match(result.warnings.join('\n'), /could not load project config/);
});

test('reply badge accepts only always, changes, or off', async (t) => {
  const { root, env } = await fixture(t);
  await mkdir(join(root, '.fabex'));
  for (const value of ['always', 'changes', 'off']) {
    await writeFile(join(root, '.fabex', 'config.json'), JSON.stringify({ display: { replyModeBadge: value } }));
    assert.equal((await loadEffectiveConfig(root, env)).config.display.replyModeBadge, value);
  }
  await writeFile(join(root, '.fabex', 'config.json'), JSON.stringify({ display: { replyModeBadge: 'sometimes' } }));
  const invalid = await loadEffectiveConfig(root, env);
  assert.equal(invalid.config.display.replyModeBadge, 'always');
  assert.match(invalid.warnings.join('\n'), /must be always, changes, or off/);
});
