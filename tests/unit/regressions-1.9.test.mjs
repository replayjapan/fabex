import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../../scripts/lib/state.mjs';
import { classifyToolUse } from '../../scripts/hook-route-guard.mjs';
import { inspectDevelopmentScript } from '../../scripts/lib/development.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = '/synthetic/workstream';
const base = initialState({ projectId: 'policy-test', canonicalRoot: root });
const classify = (command, route = 'normal', executor = {}, extra = {}) => classifyToolUse({
  state: { ...base, route, ownerSelectedMode: { route, participants: 'both' } },
  paths: { canonicalRoot: root }, invocationCwd: root, executor,
  toolName: 'Bash', toolInput: { command }, ...extra
});

test('1.9 routine work defers without per-command configuration', async () => {
  for (const executor of [{}, { agentId: 'op', agentType: 'fabex:fabex-operational' }, { agentId: 'reader', agentType: 'general-purpose' }]) {
    for (const command of ['pnpm --dir /synthetic/workstream/app install', 'npm ci', 'pnpm payload migrate:status', 'pnpm payload migrate', 'pnpm run seed:development', 'node scripts/dev-fixtures.mjs', 'node scripts/dev-db-status.mjs', 'pnpm dev', 'pnpm dev &', 'curl http://localhost:3000/', 'rg -n column app/src']) {
      assert.equal((await classify(command, 'normal', executor)).decision, 'defer', command);
    }
  }
});

test('1.9 targeted work backstops name the denied effect', async () => {
  for (const [command, rule] of [
    ['sudo pnpm install', 'privileged execution'], ['pnpm payload migrate fresh', 'database reset'],
    ['pnpm prisma migrate reset', 'database reset'], ['dropdb example', 'database drop'],
    ['psql -c "DROP TABLE example"', 'database drop'], ['NODE_ENV=production pnpm payload migrate', 'production database mutation'],
    ['pnpm seed --env-file .env.production', 'production database mutation'], ['wrangler deploy', 'deployment'],
    ['vercel --prod', 'deployment'], ['vercel', 'deployment'], ['rm -rf /', 'destructive root removal'],
    ['kill -9 123', 'unverified process termination'], ['pkill node', 'unverified process termination']
  ]) {
    const result = await classify(command); assert.equal(result.decision, 'deny', command); assert.ok(result.reason.includes(rule), result.reason);
  }
});

test('1.9 source authorship and Git delivery remain separate', async () => {
  for (const command of ['echo changed > src/file.ts', 'sed -i s/a/b/ src/file.ts', 'cp other src/file.ts', 'rm -rf .', 'ls | xargs rm', 'npm run lint -- --fix', 'git apply update.patch', 'git restore src/file.ts', 'curl -o src/file.ts http://localhost:3000/', 'node -e "require(\'fs\').writeFileSync(\'src/file.ts\',\'x\')"']) {
    assert.equal((await classify(command)).decision, 'deny', command);
  }
  assert.equal((await classify('git commit -m release', 'normal', { agentId: 'op', agentType: 'fabex:fabex-operational' })).decision, 'defer');
  for (const toolInput of [{ path: `${root}/source.ts` }, { command: 'kill 123' }]) {
    assert.equal((await classify('', 'normal', {}, { toolName: 'mcp__service__write_file', toolInput })).decision, 'deny');
  }
  assert.equal((await classify('', 'normal', {}, { toolName: 'mcp__codex__codex', toolInput: { prompt: 'bypass' } })).decision, 'deny');
});

test('1.9 discussion reads do not trust mutating exceptions', async () => {
  for (const route of ['discussion', 'ask-once']) {
    for (const command of ['rg -n x src | head -5', "awk '{print $1}' data.txt", "jq '.name' package.json", 'sort data.txt | uniq -c', 'cut -d : -f 1 data.txt', 'pnpm --dir app list --json', 'npm view package version', 'node --version', 'stat photo.png']) {
      assert.equal((await classify(command, route)).decision, 'defer', command);
    }
    for (const command of ['pnpm install', 'pnpm payload migrate', 'pnpm seed', 'node scripts/dev-db-status.mjs', "awk 'BEGIN {system(\"touch file\")}'", 'sort data.txt -o result.txt', 'ls | xargs rm', 'find . -delete', 'echo x > src/file.ts']) {
      assert.equal((await classify(command, route, {}, { config: { guard: { allowedCommandPatterns: [{ executable: 'pnpm', args: ['payload', 'migrate'] }] } } })).decision, 'deny', command);
    }
  }
});

test('1.9 image metadata and read-only delegation do not confer mutation authority', async () => {
  for (const route of ['normal', 'discussion', 'ask-once']) {
    assert.equal((await classify('stat photo.png', route)).decision, 'defer');
    assert.equal((await classify('', route, {}, { toolName: 'Read', toolInput: { file_path: `${root}/photo.png` } })).decision, 'deny');
  }
  for (const route of ['discussion', 'ask-once']) {
    assert.equal((await classify('', route, {}, { toolName: 'Agent', toolInput: { subagent_type: 'general-purpose', prompt: 'Summarize logs read-only' } })).decision, 'defer');
    assert.equal((await classify('pnpm install', route, { agentId: 'reader', agentType: 'general-purpose' })).decision, 'deny');
  }
});

test('1.9 helper reports script review notes without blanket migration or custom-launcher refusals', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'fabex-190-script-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const dev of ['node custom-dev.mjs --port 4200', 'pnpm payload migrate && next dev', 'pnpm seed:development && next dev']) {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { dev } }));
    const inspected = inspectDevelopmentScript(cwd, 'dev');
    assert.ok(inspected.notes[0].includes('not a safety verdict'));
  }
  for (const dev of ['pnpm prisma migrate reset && next dev', 'dropdb example && next dev', 'NODE_ENV=production pnpm payload migrate']) {
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { dev } }));
    assert.throws(() => inspectDevelopmentScript(cwd, 'dev'), /destructive|production/);
  }
});
