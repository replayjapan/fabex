import { sidecar, readPrivate, changePrivate } from './private-store.mjs';
import { devControl } from './dev-server.mjs';
const EMPTY = { entries: [] };

export async function resourceList(root, env = process.env) {
  const data = await readPrivate(await sidecar(root, 'task-resources.json', env), EMPTY);
  if (!Array.isArray(data.entries) || data.entries.length > 64) throw new Error('invalid resource registry');
  const dev = await readPrivate(await sidecar(root, 'dev-server.json', env), null);
  const entries = data.entries.filter(entry => entry.id !== 'dev-server');
  if (dev) {
    const annotation = data.entries.find(entry => entry.id === 'dev-server' && entry.signature === dev.signature);
    entries.unshift({ id: 'dev-server', kind: 'server', pid: dev.pid, pgid: dev.pgid, signature: dev.signature, cwd: dev.cwd, port: dev.port, startedAt: dev.startedAt,
      control: 'owned-server', retained: annotation?.retained ?? false, note: annotation?.note ?? null });
  }
  return { entries, warnings: entries.filter(entry => !entry.retained || !entry.note).map(entry => `Resource ${entry.id} needs release or a retained-resource note.`) };
}
export async function registerHostResource(root, { taskId, command }, env = process.env) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(taskId)) throw new Error('invalid host task id');
  const kind = /\bstripe\b.*\blisten\b/.test(command ?? '') ? 'forwarder' : /\b(?:chrome|playwright|browser)\b/.test(command ?? '') ? 'browser' : 'host-task';
  return changePrivate(root, 'task-resources.json', EMPTY, data => {
    if (data.entries.some(entry => entry.id === `host:${taskId}`)) return;
    if (data.entries.length >= 64) throw new Error('resource registry full');
    data.entries.push({ id: `host:${taskId}`, taskId, kind, pid: null, pgid: null, signature: null, port: null, startedAt: new Date().toISOString(), retained: false, note: null, control: 'host-task' });
  }, env);
}
export async function completeHostResource(root, taskId, env = process.env) {
  return changePrivate(root, 'task-resources.json', EMPTY, data => { data.entries = data.entries.filter(entry => entry.taskId !== taskId); }, env);
}
export async function retainResource(root, id, note, env = process.env) {
  if (typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 1024) throw new Error('retain requires a bounded nonempty note');
  const entry = (await resourceList(root, env)).entries.find(entry => entry.id === id);
  if (!entry) throw new Error('resource not found');
  return changePrivate(root, 'task-resources.json', EMPTY, data => {
    data.entries = [...data.entries.filter(item => item.id !== id), { ...entry, retained: true, note: note.trim() }];
    return { retained: id };
  }, env);
}
export async function releaseResource(root, id, { env = process.env, authorize, dependencies = {} } = {}) {
  const entry = (await resourceList(root, env)).entries.find(entry => entry.id === id);
  if (!entry) throw new Error('resource not found; no process signalled');
  if (entry.control === 'host-task') return { released: false, id, hostTaskId: entry.taskId, instruction: 'Use the host task control to stop this task, then confirm completion. Never kill a guessed PID.' };
  if (id !== 'dev-server' || entry.control !== 'owned-server') throw new Error('unverified resource ownership; no process signalled');
  const result = await devControl(root, null, ['stop'], { env, authorize, dependencies });
  await changePrivate(root, 'task-resources.json', EMPTY, data => { data.entries = data.entries.filter(item => item.id !== id); }, env);
  return { id, ...result };
}
