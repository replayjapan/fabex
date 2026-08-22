import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const tagline = 'Built for Fable: Claude and Codex collaborate through one continuous MCP thread within documented platform and behavioral limits.';

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test('plugin and marketplace metadata are consistent and authoritative', async () => {
  const plugin = JSON.parse(await readFile(resolve(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(await readFile(resolve(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(plugin.name, 'fabex');
  assert.equal(plugin.version, '1.3.0');
  assert.equal(plugin.description, tagline);
  assert.equal(marketplace.name, 'fabex');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'fabex');
  assert.equal(marketplace.plugins[0].description, tagline);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(marketplace.plugins[0].defaultEnabled, true);
  assert.equal('version' in marketplace.plugins[0], false);
});

test('hook registration is exec-form and includes synchronous MCP result events', async () => {
  const hooks = JSON.parse(await readFile(resolve(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort());
  for (const registrations of Object.values(hooks)) {
    const hook = registrations[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, 'node');
    assert.equal(Array.isArray(hook.args), true);
    assert.equal(hook.args.length, 1);
  }
});

test('only the requested public skills are packaged', async () => {
  const names = (await readdir(resolve(root, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['ask', 'askClaude', 'askCodex', 'diagnose', 'discussion', 'discussionClaude', 'discussionCodex', 'jointly', 'recover', 'status', 'work', 'workClaude'].sort());
});

test('jointly routes implementation through the canonical verified MCP thread and parity watchdog', async () => {
  const skill = await readFile(resolve(root, 'skills', 'jointly', 'SKILL.md'), 'utf8');
  assert.ok(skill.indexOf('Questions authorize answers only.') < skill.indexOf('## Route deterministically'));
  assert.match(skill, /## Route deterministically/);
  assert.match(skill, /Do not form a separate Claude implementation plan/);
  assert.match(skill, /owner's message verbatim/);
  assert.match(skill, /partnership-parity concern/);
  assert.match(skill, /Relay each flag to the owner unedited/);
  assert.match(skill, /control\.mjs thread begin/);
  assert.match(skill, /mcp__codex__codex-reply/);
  assert.match(skill, /PostToolUse hook/);
  assert.match(skill, /structured `threadId`/);
  assert.match(skill, /one checkpoint-seeded replacement/);
  assert.match(skill, /Independently run the owner's verification/);
  assert.match(skill, /Codex performs every project file edit/);
  assert.match(skill, /including delivery preflight, staging, commit, and push/);
  assert.match(skill, /pass that model explicitly/);
  assert.match(skill, /explicitly names the alternate executor/);
  assert.match(skill, /Executor exception reconciled/);
});

test('participant skills encode joint defaults, Claude work invariant, and continuous verified Codex relay', async () => {
  const workClaude = await readFile(resolve(root, 'skills', 'workClaude', 'SKILL.md'), 'utf8');
  assert.match(workClaude, /Raw Claude-only questions and answers are not relayed/);
  assert.match(workClaude, /invoke `\/fabex:jointly`/);
  assert.match(workClaude, /switches to `both`/);

  const discussion = await readFile(resolve(root, 'skills', 'discussion', 'SKILL.md'), 'utf8');
  assert.match(discussion, /--participants both/);
  assert.match(discussion, /owner's message verbatim/);
  assert.match(discussion, /workspace-write/);
  const ask = await readFile(resolve(root, 'skills', 'ask', 'SKILL.md'), 'utf8');
  assert.match(ask, /--participants both/);
  assert.match(ask, /canonical MCP/);

  const discussionCodex = await readFile(resolve(root, 'skills', 'discussionCodex', 'SKILL.md'), 'utf8');
  assert.match(discussionCodex, /canonical verified MCP thread/);
  assert.match(discussionCodex, /exact canonical threadId/);
  assert.match(discussionCodex, /stay substantively silent/);
  assert.match(discussionCodex, /Mode changes never clear it/);
});

test('MCP configuration uses the installed codex mcp-server without environment or credential fields', async () => {
  const mcp = JSON.parse(await readFile(resolve(root, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp, { mcpServers: { codex: { command: 'codex', args: ['mcp-server'] } } });
});

test('1.3.0 release notes describe the final MCP redesign and pending activation honestly', async () => {
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  const release = changelog.split('## 1.2.0')[0];
  assert.match(release, /## 1\.3\.0 - 2026-08-22/);
  assert.match(release, /synchronous `codex` and `codex-reply`/);
  assert.match(release, /one canonical `workspace-write`/);
  assert.match(release, /PostToolUse hook/);
  assert.match(release, /raw Claude-only questions and answers/);
  assert.match(release, /terminal operation records/);
  assert.match(release, /activation.*pending/i);
});

test('1.2.0 release notes disclose continuity, executor authority, guard, usage increase, wording, and migration', async () => {
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  const release = changelog.split('## 1.1.0')[0];
  assert.match(release, /## 1\.2\.0/);
  assert.match(release, /every owner message in every both-participant mode/);
  assert.match(release, /latency/i);
  assert.match(release, /Codex usage/);
  assert.match(release, /schema v1 and v2.*schema v3/);
  assert.match(release, /current-turn opinion-blind/);
  assert.match(release, /partnership-parity watchdog/);
  assert.match(release, /inspecting its resumable candidate before every `--resume-last`/);
  assert.match(release, /before any prompt launch/);
  assert.match(release, /checkpoint-seeded atomic replacement/);
  assert.match(release, /outermost-owner workstream-root resolution/);
  assert.match(release, /Codex performs all project file edits/);
  assert.match(release, /fail-closed push guard/);
  assert.match(release, /f11e7c7/);
});

test('public tree contains no removed greeting exclusion wording', async () => {
  const removedWord = new RegExp(['s', 'k', 'i', 'p'].join(''), 'i');
  const removedPhrase = new RegExp(['blind', 'independent', 'views'].join(' '), 'i');
  const demotingPhrase = new RegExp(['Claude', '(?:-led| leads)'].join(''), 'i');
  for (const path of await filesUnder(root)) {
    const content = await readFile(path, 'utf8');
    assert.doesNotMatch(content, removedWord, path);
    assert.doesNotMatch(content, removedPhrase, path);
    assert.doesNotMatch(content, demotingPhrase, path);
  }
});

test('every shipped JSON file parses', async () => {
  for (const path of await filesUnder(root)) {
    if (!path.endsWith('.json')) continue;
    assert.doesNotThrow(() => JSON.parse(awaitedContents.get(path)), path);
  }
});

const awaitedContents = new Map();
test.before(async () => {
  for (const path of await filesUnder(root)) if (path.endsWith('.json')) awaitedContents.set(path, await readFile(path, 'utf8'));
});

test('public tree contains no workstation-specific strings', async () => {
  // Hashed denylist of private identifiers — the plaintext must never appear in this repository.
  const forbiddenHashes = new Set([
    '3e44fb009899c0f900c1e74cd803b171d70a5d799d2cc933898d78e8d5fc17ca',
    'f7a14287b81d7c7951a4eed8778bccfbe8f87b744afd5aeb8362844718a47107',
    '794a2ba4efa5206ed02a75ec1b162568fa8944fe00c15d9423e53f262a1155bc',
  ]);
  const homeDirectoryPrefix = /[/](?:[Uu]sers|home)[/]/;

  for (const path of await filesUnder(root)) {
    const content = await readFile(path, 'utf8');
    assert.doesNotMatch(content, homeDirectoryPrefix, `${path} contains an absolute home-directory prefix`);

    const candidates = new Set([
      ...content.matchAll(/[\p{L}\p{N}_][\p{L}\p{N}_.@+-]*/gu),
      ...content.matchAll(/[\p{L}\p{N}_]{5,}/gu),
      ...content.matchAll(/(?<=[\\/])[\p{L}\p{N}._~@+-]+/gu),
      ...content.matchAll(/[\p{L}\p{N}._~@+-]+(?=[\\/])/gu),
    ].map((match) => match[0]));

    for (const candidate of candidates) {
      const hash = createHash('sha256').update(candidate.toLowerCase()).digest('hex');
      assert.equal(forbiddenHashes.has(hash), false, `${path} contains a forbidden private identifier`);
    }
  }
});
