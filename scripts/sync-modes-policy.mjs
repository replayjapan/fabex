#!/usr/bin/env node
// Release maintenance only. Modes owns these modules; edit its source first.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const source = resolve(process.argv[2] || resolve(import.meta.dirname, '../../modes/scripts/lib'));
const destination = resolve(import.meta.dirname, 'vendor/modes');
const names = ['state.mjs', 'shell.mjs', 'policy.mjs', 'runner.mjs', 'edits.mjs', 'contained-edits.mjs', 'edit-writer.mjs', 'lock.mjs'];
await mkdir(destination, { recursive: true });
const files = {};
for (const name of names) {
  const bytes = await readFile(join(source, name));
  await writeFile(join(destination, name), bytes);
  files[name] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ apiVersion: 1, source: 'replayjapan/modes', version: '0.1.0', files }, null, 2) + '\n');
