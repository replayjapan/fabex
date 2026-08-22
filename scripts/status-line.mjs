#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMode, isValidMode } from './lib/mode.mjs';

const MAX_BYTES = 1024 * 1024;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function fabexHome(env) {
  if (!env.FABEX_HOME) return join(homedir(), '.claude', 'plugins', 'data', 'fabex');
  return isAbsolute(env.FABEX_HOME) ? resolve(env.FABEX_HOME) : resolve(homedir(), env.FABEX_HOME);
}

async function inputJson() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('input too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function renderStatusLine(input, env = process.env) {
  try {
    const supplied = input?.workspace?.current_dir ?? input?.cwd;
    if (typeof supplied !== 'string' || supplied.length === 0) throw new Error('cwd missing');
    const canonicalRoot = await realpath(resolve(supplied));
    const projectId = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
    const projectDir = join(fabexHome(env), 'projects', projectId);
    if (await exists(join(projectDir, 'lock')) || await exists(join(projectDir, 'transaction.json'))) throw new Error('state unsettled');
    const stateFile = join(projectDir, 'state.json');
    const info = await stat(stateFile);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('state invalid');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const participants = state.schemaVersion === 1 ? 'both' : state.participants;
    if (![1, 2, 3, 4].includes(state.schemaVersion) || state.project?.id !== projectId || state.project?.canonicalRoot !== canonicalRoot || !isValidMode(state.route, participants)) throw new Error('state invalid');
    const label = formatMode(state.route, participants);
    const suffix = ['discussion', 'ask-once', 'recovery-read-only'].includes(state.route) ? ' · read-only' : '';
    return `Fabex: ${label}${suffix}`;
  } catch {
    return 'Fabex: state?';
  }
}

export async function main() {
  let input = {};
  try { input = await inputJson(); } catch {}
  process.stdout.write(`${await renderStatusLine(input)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
