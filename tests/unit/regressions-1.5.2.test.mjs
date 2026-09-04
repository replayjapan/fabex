import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { initialState } from '../../scripts/lib/state.mjs';

const pluginRoot = resolve(import.meta.dirname, '..', '..');

function context() {
  return {
    state: initialState({ projectId: '0000000000000000', canonicalRoot: pluginRoot }),
    paths: { canonicalRoot: pluginRoot },
    config: {
      project: { repositoryRoot: null },
      guard: { allowedCommands: [], allowedCommandPatterns: [], externalWriteRoots: [], readOnlyMcpTools: [] }
    }
  };
}

async function classify(command, executor = {}) {
  return classifyToolUse({ toolName: 'Bash', toolInput: { command }, executor, ...context() });
}

const operational = { agentId: 'delivery-agent', agentType: 'fabex:fabex-operational' };

test('1.5.2 dependency locks pin the exact SDK for marketplace auto-install', async () => {
  const pkg = JSON.parse(await readFile(resolve(pluginRoot, 'package.json'), 'utf8'));
  const npmLock = JSON.parse(await readFile(resolve(pluginRoot, 'package-lock.json'), 'utf8'));
  const pnpmLock = await readFile(resolve(pluginRoot, 'pnpm-lock.yaml'), 'utf8');
  assert.equal(pkg.dependencies['@openai/codex-sdk'], '0.149.0');
  assert.equal(npmLock.packages['node_modules/@openai/codex-sdk'].version, '0.149.0');
  assert.equal(npmLock.packages['node_modules/@openai/codex'].version, '0.149.0');
  assert.match(pnpmLock, /'@openai\/codex-sdk':\s*\n\s*specifier: 0\.149\.0\s*\n\s*version: 0\.149\.0/);
});

test('1.5.2 operational delivery accepts multiple commit messages with quoted parentheses', async () => {
  const command = 'git commit -m "1.5.2 - prepare marketplace" -m "Why (installer reliability)" -m "Keep the \\"Beta\\" label"';
  assert.equal((await classify(command, operational)).decision, 'defer');
  assert.equal((await classify(command)).decision, 'deny');
});

test('1.5.2 operational delivery accepts a quoted multiline commit message', async () => {
  const command = `git commit -m "1.5.2 - prepare marketplace

Auto-installs the pinned SDK dependency (without weakening delivery guards)."`;
  assert.equal((await classify(command, operational)).decision, 'defer');
  assert.equal((await classify(command)).decision, 'deny');
});

test('1.5.2 operational delivery accepts backslash-newline continuations between commit flags', async () => {
  const commands = [
    String.raw`git commit \
  -m "1.5.2 - prepare marketplace" \
  -m "Body (with parentheses)" \
  -m "Release trailer"`,
    String.raw`git -C /tmp/fabex-release commit \
  -m "1.5.2 - prepare marketplace" \
  -m "Body (with parentheses)"`
  ];
  for (const command of commands) {
    assert.equal((await classify(command, operational)).decision, 'defer', command);
    assert.equal((await classify(command)).decision, 'deny', command);
  }
});

test('1.5.2 delivery keeps command substitution and trailing shell lines denied', async () => {
  const commands = [
    `git -C /tmp/fabex-release commit -m "$(cat <<'EOF'
message
EOF
)"`,
    `git -C /tmp/fabex-release commit -m "test message"
echo "EXIT_CODE=$?"`
  ];
  for (const command of commands) {
    assert.equal((await classify(command, operational)).decision, 'deny', command);
    assert.equal((await classify(command)).decision, 'deny', command);
  }
});

test('1.5.2 README publishes the GitHub marketplace and Anthropic submission flow', async () => {
  const readme = await readFile(resolve(pluginRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /public marketplace location is not assigned/i);
  assert.match(readme, /plugin marketplace add replayjapan\/fabex/);
  assert.match(readme, /plugin install fabex@fabex/);
  assert.match(readme, /claude plugin validate \./);
  assert.match(readme, /platform\.claude\.com\/plugins\/submit/);
});
