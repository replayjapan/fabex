import { spawn } from 'node:child_process';
import { sdkLaunchOptions } from './sdk-process.mjs';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export function cleanModels(rows) {
  if (!Array.isArray(rows) || rows.length > 200) throw new Error('Invalid model catalog.');
  return rows.filter(m => m.hidden !== true).map(m => {
    if (!idPattern.test(m.model ?? '') || !Array.isArray(m.supportedReasoningEfforts)) throw new Error('Invalid model catalog.');
    const efforts = m.supportedReasoningEfforts.map(e => e.reasoningEffort);
    if (efforts.length > 16 || !efforts.every(e => /^(minimal|low|medium|high|xhigh|max|ultra|persistent)$/.test(e))) throw new Error('Invalid model effort catalog.');
    return { id: m.model, efforts: [...new Set(efforts)], defaultEffort: efforts.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : null, isDefault: m.isDefault === true };
  });
}
// No inference, history lookup, credential reads, or synthetic model fallback.
// Ask the same pinned CLI/account that executes Fabex turns.
export async function availableModels(root, env = process.env, { launch = spawn, timeout = 8000 } = {}) {
  const options = sdkLaunchOptions({}, { root, operationId: 'model-catalog', env });
  if (!options.env?.FABEX_SDK_BINARY) return { models: [], error: 'Codex model list unavailable: the installed Codex launcher could not be found.' };
  return new Promise(resolve => {
    let child, buffer = '', total = 0, rows = [], cursor = null, pages = 0, done = false;
    const finish = result => {
      if (done) return; done = true; clearTimeout(timer);
      child?.kill('SIGKILL'); child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
      resolve({ ...result, source: 'Codex model/list', checkedAt: new Date().toISOString() });
    };
    const unavailable = () => finish({ models: [], error: 'Codex model list unavailable. Check Codex sign-in and host access, then reopen settings; current choices are unchanged.' });
    const timer = setTimeout(unavailable, timeout);
    try {
      child = launch(options.env.FABEX_SDK_BINARY, ['app-server', '--listen', 'stdio://'], { cwd: root, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      const send = message => child.stdin.write(JSON.stringify(message) + '\n');
      child.on('error', unavailable); child.on('close', unavailable); child.stdin.on('error', unavailable);
      child.stderr.on('data', () => {}); // May contain private configuration; never relay it.
      child.stdout.on('data', data => {
        total += data.length; if (total > 1024 * 1024) return unavailable();
        buffer += data; let i;
        while (!done && (i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          try {
            const response = JSON.parse(line);
            if (response.id === 1) {
              if (response.error || !response.result) return unavailable();
              send({ method: 'initialized' });
              send({ id: 2, method: 'model/list', params: { limit: 50, includeHidden: false } });
            } else if (response.id === 2) {
              if (response.error || !response.result) return unavailable();
              rows.push(...cleanModels(response.result.data)); pages++;
              const next = response.result.nextCursor;
              if (next) {
                if (typeof next !== 'string' || next === cursor || next.length > 4096 || pages >= 4) return unavailable();
                cursor = next; send({ id: 2, method: 'model/list', params: { limit: 50, includeHidden: false, cursor } });
              } else finish({ models: [...new Map(rows.map(m => [m.id, m])).values()], error: null });
            }
          } catch { return unavailable(); }
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fabex_settings', version: '1.10.4' } } });
    } catch { unavailable(); }
  });
}
