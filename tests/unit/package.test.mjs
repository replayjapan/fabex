import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const tagline = 'Beta — Built for Fable: Claude and Codex collaborate as equal partners through one continuous, resumable Codex SDK thread.';

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

test('plugin, package, lockfiles, and marketplace metadata agree on 1.5.2 Beta', async () => {
  const plugin = JSON.parse(await readFile(resolve(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(await readFile(resolve(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const pnpmLock = await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8');
  const npmLock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  assert.equal(plugin.name, 'fabex');
  assert.equal(plugin.version, '1.5.2');
  assert.equal(pkg.version, '1.5.2');
  assert.equal(npmLock.version, '1.5.2');
  assert.equal(npmLock.packages[''].version, '1.5.2');
  assert.equal(plugin.description, tagline);
  assert.equal(marketplace.metadata.description, tagline);
  assert.equal(marketplace.plugins[0].description, tagline);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(marketplace.plugins[0].defaultEnabled, true);
  assert.equal(pkg.dependencies['@openai/codex-sdk'], '0.149.0');
  assert.match(pnpmLock, /'@openai\/codex-sdk':\s*\n\s*specifier: 0\.149\.0\s*\n\s*version: 0\.149\.0/);
  assert.equal(npmLock.packages['node_modules/@openai/codex-sdk'].version, '0.149.0');
  assert.equal(npmLock.packages['node_modules/@openai/codex'].version, '0.149.0');
});

test('hook registration is exec-form with no MCP result recorder', async () => {
  const hooks = JSON.parse(await readFile(resolve(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort());
  for (const registrations of Object.values(hooks)) {
    const hook = registrations[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, 'node');
    assert.equal(Array.isArray(hook.args), true);
    assert.equal(hook.args.length, 1);
  }
  await assert.rejects(access(resolve(root, 'scripts', 'hook-mcp-result.mjs')));
  await assert.rejects(access(resolve(root, 'scripts', 'lib', 'mcp-adapter.mjs')));
  await assert.rejects(access(resolve(root, '.mcp.json')));
});

test('only requested public skills are packaged and SDK protocol is authoritative', async () => {
  const names = (await readdir(resolve(root, 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['ask', 'askClaude', 'askCodex', 'diagnose', 'discussion', 'discussionClaude', 'discussionCodex', 'jointly', 'recover', 'status', 'work', 'workClaude'].sort());
  const jointly = await readFile(resolve(root, 'skills', 'jointly', 'SKILL.md'), 'utf8');
  for (const pattern of [/owner's message verbatim/, /partnership-parity concern/, /controller\.mjs submit/, /status --operation-id/, /result --operation-id/, /cancel/, /thread\.started/, /read-only/, /workspace-write/, /Codex performs project edits/, /including delivery preflight, staging, commit, and push/]) assert.match(jointly, pattern);
  assert.doesNotMatch(jointly, /mcp__codex|PostToolUse|thread begin/);
  const discussion = await readFile(resolve(root, 'skills', 'discussion', 'SKILL.md'), 'utf8');
  assert.match(discussion, /SDK's `read-only` sandbox/);
});

test('README documents Beta SDK transport, install, queue, progress, continuity, privacy, and dogfood criteria', async () => {
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  for (const pattern of [/^# Fabex — Beta/m, /Mechanically enforced and platform-limited behavior/, /@openai\/codex-sdk/, /npm ci --ignore-scripts/, /plugin marketplace add replayjapan\/fabex/, /runStreamed\(\)/, /resumeThread\(exactId/, /thread\.started/, /durable FIFO/, /Cancellation/, /hard 48 KiB/, /ChatGPT\/Codex subscription/, /no API-key/, /Codex Desktop thread count/, /process accumulation and RAM/, /activation is unknown/i]) assert.match(readme, pattern);
  assert.match(readme, /discussion.*`read-only`/i);
  assert.match(readme, /implementation.*`workspace-write`/i);
});

test('1.5.2 changelog documents marketplace packaging and guarded delivery fixes', async () => {
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  const release = changelog.split('## 1.5.1')[0];
  for (const pattern of [/## 1\.5\.2 - 2026-09-04/, /package-lock\.json/, /replayjapan\/fabex/, /Anthropic Console/, /multiline commit messages/, /No state schema/]) assert.match(release, pattern);
});

test('current implementation and consumer docs contain no obsolete MCP invocation paths', async () => {
  const currentRoots = ['scripts', 'hooks', 'skills', 'README.md', 'CONTRIBUTING.md'];
  for (const relative of currentRoots) {
    const path = resolve(root, relative);
    const candidates = (await readdirSafe(path)) ?? [path];
    for (const file of candidates) {
      const content = await readFile(file, 'utf8');
      assert.doesNotMatch(content, /mcp__codex__|codex-reply|codex mcp-server|mcp-adapter\.mjs/, file);
    }
  }
});

async function readdirSafe(path) {
  try {
    const info = await import('node:fs/promises').then(({ stat }) => stat(path));
    return info.isDirectory() ? filesUnder(path) : null;
  } catch { return null; }
}

test('every shipped JSON file parses', async () => {
  for (const path of await filesUnder(root)) if (path.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(awaitedContents.get(path)), path);
});

const awaitedContents = new Map();
test.before(async () => {
  for (const path of await filesUnder(root)) if (path.endsWith('.json')) awaitedContents.set(path, await readFile(path, 'utf8'));
});

test('public tree contains no workstation-specific strings or private identifiers', async () => {
  const forbiddenHashes = new Set([
    '3e44fb009899c0f900c1e74cd803b171d70a5d799d2cc933898d78e8d5fc17ca',
    'f7a14287b81d7c7951a4eed8778bccfbe8f87b744afd5aeb8362844718a47107',
    '794a2ba4efa5206ed02a75ec1b162568fa8944fe00c15d9423e53f262a1155bc'
  ]);
  const homeDirectoryPrefix = /[/](?:[Uu]sers|home)[/]/;
  for (const path of await filesUnder(root)) {
    const content = await readFile(path, 'utf8');
    assert.doesNotMatch(content, homeDirectoryPrefix, `${path} contains an absolute home-directory prefix`);
    const candidates = new Set([...content.matchAll(/[\p{L}\p{N}_][\p{L}\p{N}_.@+-]*/gu)].map((match) => match[0]));
    for (const candidate of candidates) {
      const hash = createHash('sha256').update(candidate.toLowerCase()).digest('hex');
      assert.equal(forbiddenHashes.has(hash), false, `${path} contains a forbidden private identifier`);
    }
  }
});
