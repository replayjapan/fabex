import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { initializeState, readState } from '../../scripts/lib/state.mjs';
import { issueModeGrant } from '../../scripts/lib/hook-evidence.mjs';
import { applyOwnerModeTransition, claimNextOperation, runOperation, submissionEnvelope, submitOperation } from '../../scripts/lib/sdk-controller.mjs';
import { selectedModeAttachments } from '../../scripts/lib/attachments.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';

const root = resolve(import.meta.dirname, '../..');
const operational = { agentId: 'helper-171', agentType: 'fabex:fabex-operational' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fabex-171-'));
  const project = join(directory, 'workspace'); await mkdir(join(project, 'app'), { recursive: true });
  const env = { ...process.env, FABEX_HOME: join(directory, 'state'), CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') };
  await mkdir(join(project, '.fabex'));
  await writeFile(join(project, '.fabex/config.json'), JSON.stringify({ schemaVersion: 1, project: { repositoryRoot: 'app' } }));
  await initializeState(project, env);
  const config = (await loadEffectiveConfig(project, env)).config;
  const image = join(project, 'app', '画面 review.png'); await writeFile(image, 'fixture-image');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const classify = async (toolName, toolInput, route = 'discussion', executor = {}) => {
    const stateResult = await readState(project, env);
    stateResult.state.route = route;
    return (await classifyToolUse({ ...stateResult, toolName, toolInput, executor, config })).decision;
  };
  return { project, env, config, image, classify };
}

test('1.7.1 item 1: instructions make Codex the image reviewer and Fable the description consumer', async () => {
  for (const file of ['skills/jointly/SKILL.md', 'skills/ask/SKILL.md', 'skills/discussion/SKILL.md', 'agents/operational.md']) {
    const text = await readFile(join(root, file), 'utf8');
    assert.match(text, /Codex.*default image reviewer/i);
    assert.match(text, /Fable/);
  }
});

test('1.7.1 item 2: direct image reads remain denied while metadata and attachment transport work', async (t) => {
  const { image, classify } = await fixture(t);
  for (const route of ['normal', 'discussion', 'ask-once']) {
    for (const executor of [{}, { agentId: 'other', agentType: 'general-purpose' }]) {
      for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'heic']) {
        const path = `${image}.${extension.toUpperCase()}`;
        assert.equal(await classify('Read', { file_path: path }, route, executor), 'deny');
        assert.equal(await classify('Bash', { command: `stat "${path}"` }, route, executor), 'defer');
        assert.equal(await classify('mcp__service__read_file', { path }, route, executor), 'defer');
      }
    }
    assert.equal(await classify('Read', { file_path: image }, route, operational), 'defer');
    assert.equal(await classify('Read', { file_path: 'README.md' }, route), 'defer');
  }
  const envelope = JSON.stringify({ ...JSON.parse(submissionEnvelope('review')), attachments: [image] });
  const command = `node "${join(root, 'scripts/controller.mjs')}" submit <<'FABEX_IMAGE_1710'\n${envelope}\nFABEX_IMAGE_1710`;
  assert.equal(await classify('Bash', { command }), 'defer');
  assert.equal(await classify('Bash', { command: "stat screen.pn'g' | head" }, 'normal'), 'defer');
  assert.equal(await classify('Bash', { command: 'git commit -m "no"' }, 'normal'), 'defer');
  assert.equal(await classify('Bash', { command: 'git commit -m "no"' }, 'discussion', operational), 'deny');
});

test('1.7.1 item 3: read-only delegation permits more than the image envelope while tool mutations stay denied', async (t) => {
  const { image, config, classify } = await fixture(t);
  const input = { subagent_type: 'fabex:fabex-operational', model: config.models.operational, prompt: `FABEX IMAGE DESCRIPTION ONLY\n${JSON.stringify({ attachments: [image] })}` };
  for (const route of ['discussion', 'ask-once']) {
    assert.equal(await classify('Agent', input, route), 'defer');
    assert.equal(await classify('Task', input, route), 'defer');
    for (const altered of [{ ...input, model: 'wrong-model' }, { ...input, prompt: 'perform delivery' }, { ...input, resume: 'other-agent' }, { ...input, prompt: `${input.prompt}\nextra instructions` }]) {
      assert.equal(await classify('Agent', altered, route), 'defer', '1.9 delegates read-only chores beyond the image envelope');
    }
    assert.equal(await classify('Edit', { file_path: image, old_string: 'a', new_string: 'b' }, route, operational), 'deny');
  }
  assert.equal(await classify('Agent', input, 'recovery-read-only'), 'deny');
});

test('1.7.1 item 4: explicit mode attachments reach Phase 1 with the owner message byte-for-byte', async (t) => {
  const { project, env, image } = await fixture(t);
  const ownerMessage = `日本語 — **review**\n\nMention only: ${image}\nattach: ${image}\n\n`;
  assert.deepEqual(selectedModeAttachments(`Mention only: ${image}`), []);
  assert.throws(() => selectedModeAttachments('attach: relative.png'), /absolute/);
  const grant = await issueModeGrant(project, { sessionId: 'session', route: 'discussion', participants: 'both', ownerMessage }, env);
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  const op = await claimNextOperation(project, env);
  assert.deepEqual(Buffer.from(op.request.ownerMessage), Buffer.from(ownerMessage));
  assert.deepEqual(op.request.attachments, [await realpath(image)]);
  const calls = [];
  const createCodex = async () => ({ startThread: (options) => ({ runStreamed: async (input) => {
    calls.push({ options, input });
    return { events: (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-171' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'image received' } };
      yield { type: 'turn.completed' };
    })() };
  } }) });
  await runOperation(project, op, { createCodex }, env);
  assert.equal(calls[0].options.sandboxMode, 'read-only');
  assert.ok(calls[0].input[0].text.includes(ownerMessage));
  assert.doesNotMatch(calls[0].input[0].text, /FABLE RESPONSE|CURRENT FABLE/);
  assert.deepEqual(calls[0].input[1], { type: 'local_image', path: await realpath(image) });
  assert.deepEqual((await readState(project, env)).state.operations[0].request.attachments, []);
});

test('1.7.1 item 4: missing selected image preserves the unused mode grant and exact text', async (t) => {
  const { project, env } = await fixture(t);
  const ownerMessage = `attach: ${join(project, 'missing.png')}`;
  const grant = await issueModeGrant(project, { sessionId: 'session', route: 'discussion', participants: 'both', ownerMessage }, env);
  await assert.rejects(applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false }), /ENOENT/);
  const state = (await readState(project, env)).state;
  assert.equal(state.modeGrant.id, grant.id); assert.equal(state.modeGrant.ownerMessage, ownerMessage);
  assert.equal(state.route, 'normal'); assert.equal(state.operations.length, 0);
});

test('1.7.1 item 5: discussion research defers without permitting image reads or unrelated effects', async (t) => {
  const { classify } = await fixture(t);
  for (const route of ['discussion', 'ask-once']) {
    assert.equal(await classify('WebSearch', { query: 'official documentation' }, route), 'defer');
    assert.equal(await classify('WebFetch', { url: 'https://example.org/docs', prompt: 'summarize' }, route), 'defer');
    assert.equal(await classify('Agent', { subagent_type: 'claude-code-guide', prompt: 'research hooks' }, route), 'defer');
    assert.equal(await classify('Agent', { subagent_type: 'general-purpose', prompt: 'research hooks' }, route), 'defer');
    for (const url of ['file:///scratch/page', 'https://user:password@example.org/docs', 'https://example.org/image.png']) assert.equal(await classify('WebFetch', { url }, route), 'deny');
    assert.equal(await classify('mcp__service__create_item', {}, route), 'deny');
  }
  assert.equal(await classify('WebSearch', { query: 'research' }, 'recovery-read-only'), 'deny');
});

test('1.7.1 item 4: paused transition revalidates images without losing the completed operation or grant', async (t) => {
  const { project, env, image } = await fixture(t);
  await submitOperation(project, submissionEnvelope('active work'), env, { spawnRunner: false });
  const active = await claimNextOperation(project, env);
  const ownerMessage = `attach: ${image}`;
  const grant = await issueModeGrant(project, { sessionId: 'session', route: 'discussion', participants: 'both', ownerMessage }, env);
  const pending = await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  assert.equal(pending.status, 'pending');
  await rm(image);
  const abort = new AbortController(); abort.abort();
  await runOperation(project, active, { createCodex: async () => { throw new DOMException('cancelled', 'AbortError'); }, signal: abort.signal }, env);
  const state = (await readState(project, env)).state;
  assert.equal(state.operations[0].status, 'cancelled');
  assert.match(state.operations[0].result.warning, /grant and text retained/);
  assert.equal(state.modeGrant.id, grant.id); assert.equal(state.modeGrant.ownerMessage, ownerMessage);
  assert.equal(state.route, 'normal');
  await writeFile(image, 'restored fixture');
  await applyOwnerModeTransition(project, { grantId: grant.id, route: 'discussion', participants: 'both' }, env, { spawnRunner: false });
  const after = (await readState(project, env)).state;
  assert.equal(after.modeGrant, null); assert.equal(after.route, 'discussion');
  assert.deepEqual(after.operations.at(-1).request.attachments, [await realpath(image)]);
});

test('1.7.1 cleanup: local Claude settings are ignored portably, not removed', async () => {
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\.claude\/$/m);
});
