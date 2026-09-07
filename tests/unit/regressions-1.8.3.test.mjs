import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeState } from '../../scripts/lib/state.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { classifyToolUse, classifyUnhealthyToolUse } from '../../scripts/hook-route-guard.mjs';
import { detectDevelopment, inspectDevelopmentScript, developmentProbe } from '../../scripts/lib/development.mjs';
import { devControl } from '../../scripts/lib/dev-server.mjs';

const plugin = resolve(import.meta.dirname, '../..');
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fabex-183-')));
  const root = join(dir, 'project'); const app = join(root, 'app'); await mkdir(app, { recursive: true });
  const env = { ...process.env, FABEX_HOME: join(dir, 'state') };
  const initialized = await initializeState(root, env);
  const config = (await loadEffectiveConfig(root, env)).config;
  const pkg = async (scripts = { dev: 'cross-env NODE_OPTIONS=--no-deprecation next dev', start: 'next start' }, extra = {}) => writeFile(join(app, 'package.json'), JSON.stringify({ scripts, ...extra }));
  await pkg();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { ...initialized.state, route: 'normal', ownerSelectedMode: { route: 'normal', participants: 'both' } };
  const classify = (command, route = 'normal', executor = {}, extra = {}) => classifyToolUse({ ...initialized, state: { ...state, route, ownerSelectedMode: { route, participants: 'both' } }, config, env, executor, invocationCwd: app, toolName: 'Bash', toolInput: { command, run_in_background: true }, ...extra });
  return { root, app, dir, pkg, config, env, classify, ...initialized };
}

test('1.8.3 ordinary dev/start commands work without configuration for main and operational executors', async t => {
  const f = await fixture(t); assert.equal(f.config.devServer, null);
  for (const manager of ['pnpm', 'npm', 'yarn']) for (const run of ['', 'run ']) for (const script of ['dev', 'start']) {
    const command = `${manager} ${run}${script} -- --hostname 0.0.0.0 --port 3000`;
    for (const executor of [{}, { agentId: 'op', agentType: 'fabex:fabex-operational' }]) assert.equal((await f.classify(command, 'normal', executor)).decision, 'defer', command);
    assert.equal((await f.classify(command, 'normal', { agentId: 'other', agentType: 'general-purpose' })).decision, 'deny');
    for (const route of ['discussion', 'ask-once', 'recovery-read-only']) assert.equal((await f.classify(command, route)).decision, 'deny');
  }
  for (const command of ['pnpm install', 'npm exec arbitrary', 'node other-script.mjs', 'pnpm payload migrate', 'kill 3000']) assert.equal((await f.classify(command)).decision, 'deny');
  for (const command of ['pnpm test', 'pnpm lint', 'npm run typecheck', 'yarn build', 'pnpm check']) assert.equal((await f.classify(command)).decision, 'defer');
});

test('1.8.3 directory selectors and cd honor actual host cwd and reject escaped or composed launches', async t => {
  const f = await fixture(t);
  for (const selector of ['pnpm --dir', 'pnpm -C', 'npm --prefix', 'yarn --cwd']) {
    assert.equal((await f.classify(`${selector} "${f.app}" dev`, 'normal', {}, { invocationCwd: f.root })).decision, 'defer');
    assert.equal((await f.classify(`${selector} "${f.dir}" dev`)).decision, 'deny');
  }
  await symlink(f.dir, join(f.root, 'escape'));
  assert.equal((await f.classify(`pnpm --dir "${f.root}/escape" dev`)).decision, 'deny');
  assert.equal((await f.classify(`cd "${f.app}" && pnpm dev`, 'normal', {}, { invocationCwd: f.root })).decision, 'defer');
  for (const command of [`cd "${f.app}"; pnpm dev`, `cd "${f.app}" && pnpm dev && pwd`, 'pnpm dev | head', 'pnpm dev --dir /outside', 'pnpm dev --fix', 'pnpm dev --eval code']) assert.equal((await f.classify(command)).decision, 'deny', command);
  assert.equal((await f.classify('pnpm dev', 'normal', {}, { invocationCwd: f.root, config: { ...f.config, project: { repositoryRoot: 'app' } } })).decision, 'deny', 'repositoryRoot must not pretend to change the shell cwd');
});

test('1.8.3 script inspection covers database chains, lifecycle hooks, nested scripts and source-write shapes', async t => {
  const f = await fixture(t);
  for (const word of ['migrate', 'db:push', 'reset', 'seed', 'drop']) {
    await f.pkg({ dev: `pnpm ${word} && next dev` });
    const result = await f.classify('pnpm dev'); assert.equal(result.decision, 'deny'); assert.ok(result.reason.includes(word));
  }
  for (const scripts of [{ predev: 'pnpm payload migrate', dev: 'next dev' }, { dev: 'next dev', postdev: 'rm source.ts' }, { dev: 'node rewrite-source.mjs' }, { dev: 'next dev > source.ts' }, { dev: 'NODE_OPTIONS=--require=./write.js next dev' }, { dev: 'pnpm run inner', inner: 'pnpm run dev' }, { dev: 'pnpm run inner', inner: 'node -e code' }]) {
    await f.pkg(scripts); assert.equal((await f.classify('pnpm dev')).decision, 'deny', JSON.stringify(scripts));
  }
  await f.pkg({ dev: 'pnpm run serve', serve: 'next dev --port 4010' });
  assert.equal(inspectDevelopmentScript(f.app, 'dev').port, 4010);
  assert.equal((await f.classify('pnpm dev')).decision, 'defer');
});

test('1.8.3 bounded loopback probes work in read-only routes without redirects, writes, bodies or config tricks', async t => {
  const f = await fixture(t);
  const curl = "curl -q --noproxy '*' --max-time 5";
  for (const route of ['normal', 'discussion', 'ask-once']) for (const command of ['lsof -nP -iTCP:3000 -sTCP:LISTEN', 'lsof -i :5173', `${curl} -sS -I http://localhost:3000/`, `${curl} -X GET -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/`, `${curl} -L --max-redirs 0 http://localhost:3000/`]) assert.equal((await f.classify(command, route)).decision, 'defer', command);
  for (const command of [`${curl} -L http://localhost:3000/`, `${curl} -X POST http://localhost:3000/`, `${curl} -d data http://localhost:3000/`, `${curl} -o source.ts http://localhost:3000/`, `${curl} -w '%output{source.ts}' http://localhost:3000/`, `${curl} -K file http://localhost:3000/`, `${curl} http://example.test:3000/`, 'curl -q http://localhost:3000/', 'lsof -i :0', 'lsof -i :65536']) for (const route of ['normal', 'discussion', 'ask-once']) assert.equal((await f.classify(command, route)).decision, 'deny', command);
  for (const health of ['corrupt', 'lock-contention', 'migration-deferred']) assert.equal(classifyUnhealthyToolUse({ health, toolName: 'Bash', toolInput: { command: `${curl} http://localhost:3000/` } }).decision, 'deny');
  assert.equal(developmentProbe(['curl', '-q', '--max-time', '2', 'http://localhost:3000/'], { http_proxy: 'http://proxy.invalid' }), false);
});

test('1.8.3 automatic discovery finds a nested app, manager and intended port without saving configuration', async t => {
  const f = await fixture(t);
  await writeFile(join(f.app, 'pnpm-lock.yaml'), '');
  for (const [body, port] of [['next dev --port 3100', 3100], ['PORT=3200 next dev', 3200], ['next dev -p 3300', 3300], ['next dev', 3000], ['vite', 5173]]) {
    await f.pkg({ dev: body }); const detected = detectDevelopment(f.root, f.config);
    assert.equal(detected.cwd, f.app); assert.equal(detected.start[0], 'pnpm'); assert.equal(detected.port, port); assert.ok(detected.start.includes(String(port)));
  }
  await f.pkg({ start: 'next start' }, { packageManager: 'yarn@1.22.0' });
  assert.equal(detectDevelopment(f.root, f.config).start[0], 'yarn');
  await assert.rejects(readFile(join(f.root, '.fabex/config.json')), { code: 'ENOENT' });
});

test('1.8.3 ambiguous applications and package managers require a choice instead of guessing', async t => {
  const f = await fixture(t); const other = join(f.root, 'second'); await mkdir(other); await writeFile(join(other, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  assert.throws(() => detectDevelopment(f.root, f.config), /several development applications:.*app.*second/);
  const selected = { ...f.config, project: { repositoryRoot: 'app' } };
  assert.equal(detectDevelopment(f.root, selected).cwd, f.app);
  await writeFile(join(f.app, 'yarn.lock'), ''); await writeFile(join(f.app, 'package-lock.json'), '{}');
  assert.throws(() => detectDevelopment(f.root, selected), /competing package-manager/);
});

test('1.8.3 auto-detected helper refuses an occupied intended port without launching or signalling', async t => {
  const f = await fixture(t); const config = detectDevelopment(f.root, f.config);
  let launched = false; let signalled = false;
  await assert.rejects(devControl(f.root, config, ['start'], { env: f.env, authorize: async () => {}, dependencies: { identity: async () => null, listeners: async port => { assert.equal(port, 3000); return [{ pid: 765, command: 'other' }]; }, launch: async () => { launched = true; }, signal: () => { signalled = true; } } }), /port 3000 conflict: 765/);
  assert.equal(launched, false); assert.equal(signalled, false);
  const command = `node "${plugin}/scripts/control.mjs" dev start`;
  assert.equal((await f.classify(command)).decision, 'defer');
  assert.equal((await f.classify(command, 'discussion')).decision, 'deny');
});

test('1.8.3 detected lifecycle reports command cwd port and stops from ownership without an override', async t => {
  const f = await fixture(t); const config = detectDevelopment(f.root, f.config);
  let live = false; let clock = Date.now(); const pid = 678;
  const dependencies = {
    identity: async target => live && target === pid ? { pid, pgid: pid, signature: 'fixture-start|node' } : null,
    listeners: async () => live ? [{ pid, command: 'node' }] : [],
    members: async () => live ? [pid] : [],
    launch: async () => { live = true; return pid; },
    signal: async target => { assert.equal(target, -pid); live = false; },
    ready: async () => ({ ready: live, statusCode: live ? 200 : null }),
    now: () => clock, sleep: async ms => { clock += ms; }
  };
  const options = { env: f.env, dependencies, authorize: async () => {} };
  const started = await devControl(f.root, config, ['start'], options);
  assert.equal(started.cwd, f.app); assert.equal(started.port, 3000); assert.deepEqual(started.command, config.start);
  const status = await devControl(f.root, null, ['status'], options);
  assert.equal(status.owned, true); assert.equal(status.cwd, f.app); assert.deepEqual(status.command, config.start);
  assert.equal((await devControl(f.root, null, ['stop'], options)).status, 'stopped');
});
