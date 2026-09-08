import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { initializeState } from '../../scripts/lib/state.mjs';
import { loadEffectiveConfig } from '../../scripts/lib/config.mjs';
import { validateDevServer } from '../../scripts/lib/validation.mjs';
import { devControl, parseDevArgs, parseProcessIdentity, parsePortListeners, launchDevProcess } from '../../scripts/lib/dev-server.mjs';
import { classifyToolUse, classifyUnhealthyToolUse } from '../../scripts/hook-route-guard.mjs';

const plugin = resolve(import.meta.dirname, '../..');
const setting = { start: ['pnpm', 'dev', '--hostname', '0.0.0.0', '--port', '3000'], port: 3000, readyUrl: 'http://localhost:3000/', readyTimeoutMs: 100, stopGraceMs: 100 };
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'fabex-182-')));
  const project = join(directory, 'project');
  await mkdir(join(project, 'app'), { recursive: true });
  await mkdir(join(project, '.fabex'));
  const env = { ...process.env, FABEX_HOME: join(directory, 'data') };
  const initialized = await initializeState(project, env);
  const put = value => writeFile(join(project, '.fabex/config.json'), JSON.stringify(value));
  await put({ project: { repositoryRoot: 'app' }, devServer: setting });
  const effective = await loadEffectiveConfig(project, env);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project, env, put, ...initialized, config: effective.config };
}
function simulation() {
  let clock = 1800000000000;
  const identities = new Map(); let ports = []; let nextPid = 201;
  const signals = []; const launches = []; let failTerm = false;
  return {
    identities, signals, launches,
    set ports(value) { ports = value; },
    set failTerm(value) { failTerm = value; },
    dependencies: {
      now: () => clock, sleep: async ms => { clock += ms; },
      identity: async pid => identities.get(pid) ?? null,
      listeners: async () => structuredClone(ports),
      members: async pgid => [...identities.values()].filter(p => p.pgid === pgid).map(p => p.pid),
      ready: async () => ({ ready: ports.length > 0, statusCode: ports.length ? 200 : null }),
      launch: async (config, fd) => {
        const pid = nextPid++;
        launches.push({ config, fd });
        identities.set(pid, { pid, pgid: pid, signature: `start-${clock}|node` });
        ports = [{ pid, command: 'node' }]; return pid;
      },
      signal: async (group, signal) => {
        signals.push({ group, signal });
        if (signal === 'SIGTERM' && failTerm) return;
        for (const [pid, info] of identities) if (info.pgid === -group) { identities.delete(pid); ports = ports.filter(p => p.pid !== pid); }
      }
    }
  };
}
const run = (f, sim, args, extra = {}) => devControl(f.project, f.config.devServer, args, { env: f.env, dependencies: sim.dependencies, authorize: async () => {}, ...extra });

test('1.8.2 project-only dev config is strict, cwd-contained and disabled on error', async t => {
  const f = await fixture(t);
  assert.equal(f.config.devServer.cwd, join(f.project, 'app'));
  for (const change of [{ start: 'pnpm dev' }, { start: [] }, { start: ['pnpm', 'dev\nwhoami'] }, { port: 0 }, { port: 65536 }, { port: 3.5 }, { readyUrl: 'https://localhost:3000/' }, { readyUrl: 'http://example.test:3000/' }, { readyUrl: 'http://localhost:3001/' }, { readyUrl: 'http://user:pass@localhost:3000/' }, { readyTimeoutMs: 999999 }, { stopGraceMs: -1 }, { shell: true }]) {
    await f.put({ devServer: { ...setting, ...change } });
    const effective = await loadEffectiveConfig(f.project, f.env);
    assert.equal(effective.config.devServer, null); assert.match(effective.warnings.join(' '), /devServer/);
  }
  await symlink(f.directory, join(f.project, 'escape'));
  for (const cwd of ['..', 'escape', '/tmp']) {
    await f.put({ devServer: { ...setting, cwd } }); assert.equal((await loadEffectiveConfig(f.project, f.env)).config.devServer, null);
  }
  await writeFile(join(f.env.FABEX_HOME, 'config.json'), JSON.stringify({ devServer: setting }));
  await f.put({});
  const effective = await loadEffectiveConfig(f.project, f.env);
  assert.equal(effective.config.devServer, null); assert.match(effective.warnings.join(' '), /project-layer only/);
  assert.equal(validateDevServer({ ...setting, readyTimeoutMs: undefined }).readyTimeoutMs, 30000);
});

test('1.8.2 dev guard preserves lifecycle route and ownership boundaries under the 1.9 work policy', async t => {
  const f = await fixture(t);
  const controls = ['start', 'stop', 'restart', 'status', 'logs', 'logs --lines 400'];
  const executors = [{}, { agentId: 'helper', agentType: 'fabex:fabex-operational', verified: true }, { agentId: 'other', agentType: 'general-purpose' }];
  for (const route of ['normal', 'discussion', 'ask-once', 'recovery-read-only']) {
    const state = { ...f.state, route, ownerSelectedMode: { route, participants: 'both' } };
    for (const [index, executor] of executors.entries()) for (const control of controls) {
      const result = await classifyToolUse({ ...f, state, executor, toolName: 'Bash', toolInput: { command: `node "${plugin}/scripts/control.mjs" dev ${control}` } });
      const mutation = ['start', 'stop', 'restart'].includes(control);
      assert.equal(result.decision, route === 'recovery-read-only' || mutation && (route !== 'normal' || index === 2) ? 'deny' : 'defer', `${route}/${index}/${control}: ${result.reason}`);
    }
    for (const command of ['pnpm dev', 'pnpm payload migrate', 'pnpm payload migrate:status', 'curl http://localhost:3000/', 'kill -9 1234']) {
      assert.equal((await classifyToolUse({ ...f, state, toolName: 'Bash', toolInput: { command } })).decision, route === 'normal' && !command.startsWith('kill') ? 'defer' : 'deny', `${route}: ${command}`);
    }
  }
  for (const health of ['lock-contention', 'corrupt', 'migration-deferred']) for (const action of controls) assert.equal(classifyUnhealthyToolUse({ health, toolName: 'Bash', toolInput: { command: `node "${plugin}/scripts/control.mjs" dev ${action}` } }).decision, 'deny');
  const state = { ...f.state, route: 'normal', ownerSelectedMode: { route: 'normal', participants: 'both' } };
  for (const suffix of ['start && pwd', 'start | head', 'logs --lines 401', 'logs --lines 0', 'start extra']) {
    assert.equal((await classifyToolUse({ ...f, state, toolName: 'Bash', toolInput: { command: `node "${plugin}/scripts/control.mjs" dev ${suffix}` } })).decision, 'deny');
  }
  const result = await classifyToolUse({ ...f, state, config: { ...f.config, devServer: null }, toolName: 'Bash', toolInput: { command: `node "${plugin}/scripts/control.mjs" dev start` } });
  assert.equal(result.decision, 'defer'); // 1.8.3: configuration is no longer an enablement gate.
});

test('1.8.2 simulated lifecycle survives calls and restarts/stops only its owned process group', async t => {
  const f = await fixture(t); const sim = simulation();
  const started = await run(f, sim, ['start']);
  assert.equal(started.status, 'started');
  assert.equal(sim.launches[0].config.cwd, join(f.project, 'app'));
  assert.deepEqual(sim.launches[0].config.start, setting.start);
  assert.equal((await run(f, sim, ['status'])).owned, true);
  assert.equal((await run(f, sim, ['start'])).status, 'already-running');
  const restarted = await run(f, sim, ['restart']);
  assert.notEqual(restarted.pid, started.pid);
  sim.failTerm = true;
  assert.equal((await run(f, sim, ['stop'])).status, 'stopped');
  assert.deepEqual(sim.signals, [{ group: -started.pid, signal: 'SIGTERM' }, { group: -restarted.pid, signal: 'SIGTERM' }, { group: -restarted.pid, signal: 'SIGKILL' }]);
  assert.equal((await run(f, sim, ['status'])).record, 'absent');
});

test('1.8.2 port conflicts fail visibly without launching or killing unrelated listeners', async t => {
  const f = await fixture(t); const sim = simulation();
  sim.ports = [{ pid: 912, command: 'unrelated' }];
  await assert.rejects(run(f, sim, ['start']), /conflict: 912 \(unrelated\)/);
  assert.deepEqual(sim.launches, []); assert.deepEqual(sim.signals, []);
});

test('1.8.2 stale PID and identity mismatch clear only the record and never signal', async t => {
  for (const mismatch of [false, true]) {
    const f = await fixture(t); const sim = simulation();
    const started = await run(f, sim, ['start']);
    if (mismatch) sim.identities.get(started.pid).signature = 'reused-pid|other';
    else sim.identities.delete(started.pid);
    const stopped = await run(f, sim, ['stop']);
    assert.equal(stopped.status, 'stale'); assert.equal(stopped.signalled, false); assert.deepEqual(sim.signals, []);
    await assert.rejects(readFile(join(f.paths.projectDir, 'dev-server.json')), { code: 'ENOENT' });
    await assert.rejects(run(f, sim, ['start']), /conflict/);
  }
});

test('1.8.2 status and bounded redacted logs never mutate, repair or signal', async t => {
  const f = await fixture(t); const sim = simulation();
  const started = await run(f, sim, ['start']);
  const record = join(f.paths.projectDir, 'dev-server.json');
  const before = await readFile(record, 'utf8');
  sim.identities.delete(started.pid);
  const log = join(f.paths.projectDir, 'dev-server.log');
  await writeFile(log, 'x'.repeat(80000) + '\npostgres://user:secret@localhost/db\nTOKEN=private-value\nlast\n');
  const names = await readdir(f.paths.projectDir);
  const logBefore = await readFile(log, 'utf8');
  const unauthorized = { authorize: async () => { throw new Error('mutation attempted'); } };
  assert.equal((await run(f, sim, ['status'], unauthorized)).record, 'stale');
  const output = await run(f, sim, ['logs', '--lines', '3'], unauthorized);
  assert.doesNotMatch(output.text, /user:secret|private-value/); assert.match(output.text, /last/);
  assert.equal(await readFile(record, 'utf8'), before); assert.equal(await readFile(log, 'utf8'), logBefore);
  assert.deepEqual(await readdir(f.paths.projectDir), names); assert.deepEqual(sim.signals, []);
  for (const args of [['logs', '--lines', '401'], ['logs', '--lines', '0'], ['stop', '912']]) assert.throws(() => parseDevArgs(args));
  await assert.rejects(run(f, sim, ['restart'], unauthorized), /mutation attempted/);
});

test('1.8.2 ownership changes before a signal fail closed and log symlinks are refused', async t => {
  const f = await fixture(t); const sim = simulation();
  const started = await run(f, sim, ['start']);
  let authorizations = 0;
  await assert.rejects(run(f, sim, ['stop'], { authorize: async () => { if (++authorizations === 3) sim.identities.get(started.pid).signature = 'changed'; } }), /identity changed/);
  assert.deepEqual(sim.signals, []);
  const log = join(f.paths.projectDir, 'dev-server.log');
  await rm(log); await symlink(join(f.paths.projectDir, 'state.json'), log);
  await assert.rejects(run(f, sim, ['logs']));
});

test('1.8.2 native adapter preserves detached argv and parses bounded process evidence without a server', async () => {
  let unref = false; let invocation;
  const spawn = (...args) => { invocation = args; const child = new EventEmitter(); child.pid = 321; child.unref = () => { unref = true; }; queueMicrotask(() => child.emit('spawn')); return child; };
  assert.equal(await launchDevProcess({ ...setting, cwd: '/project/app' }, 42, spawn), 321);
  assert.deepEqual(invocation, ['pnpm', setting.start.slice(1), { cwd: '/project/app', detached: true, shell: false, stdio: ['ignore', 42, 42] }]);
  assert.equal(unref, true);
  assert.deepEqual(parseProcessIdentity(321, '321 321 Mon Sep  7 11:15:23 2026 /usr/local/bin/node'), { pid: 321, pgid: 321, signature: 'Mon Sep 7 11:15:23 2026|/usr/local/bin/node' });
  assert.throws(() => parseProcessIdentity(123, '321 321 Mon Sep 7 11:15:23 2026 node'));
  assert.deepEqual(parsePortListeners('p321\ncnode\np322\ncnode\n'), [{ pid: 321, command: 'node' }, { pid: 322, command: 'node' }]);
  assert.throws(() => parsePortListeners('unrecognized'));
});

test('1.8.2 disabled/absent inspection, lock conflicts and inspection failures have no lifecycle side effects', async t => {
  const f = await fixture(t); const sim = simulation();
  const before = await readdir(f.paths.projectDir);
  await devControl(f.project, null, ['status'], { env: f.env, dependencies: sim.dependencies });
  await run(f, sim, ['logs']);
  assert.deepEqual(await readdir(f.paths.projectDir), before);
  await assert.rejects(run(f, sim, ['start'], { dependencies: { ...sim.dependencies, listeners: async () => { throw new Error('inspection refused'); } } }), /inspection refused/);
  assert.deepEqual(sim.launches, []); assert.deepEqual(sim.signals, []);
  await writeFile(join(f.paths.projectDir, 'dev-server.lock'), 'other command');
  await assert.rejects(run(f, sim, ['restart']), /holds the lock/);
  assert.equal(await readFile(join(f.paths.projectDir, 'dev-server.lock'), 'utf8'), 'other command');
  assert.deepEqual(sim.launches, []); assert.deepEqual(sim.signals, []);
});

test('1.8.2 child listener ownership is group-scoped and orphaned children are not guessed or killed', async t => {
  const f = await fixture(t); const sim = simulation();
  const started = await run(f, sim, ['start']);
  sim.identities.set(987, { pid: 987, pgid: started.pid, signature: 'child-start|node' });
  sim.ports = [{ pid: 987, command: 'node' }];
  assert.equal((await run(f, sim, ['status'])).listeners[0].ours, true);
  await assert.rejects(run(f, sim, ['stop'], { dependencies: { ...sim.dependencies, signal: async () => { sim.identities.delete(started.pid); } } }), /stop incomplete/);
  assert.equal(sim.identities.has(987), true);
  assert.equal((await run(f, sim, ['status'])).listeners[0].ours, false);
});
