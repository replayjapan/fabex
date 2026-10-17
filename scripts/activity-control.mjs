#!/usr/bin/env node
import { decodeEdits } from './vendor/modes/edits.mjs';
import { applyContainedEdits } from './vendor/modes/contained-edits.mjs';
import { snapshot } from './vendor/modes/state.mjs';
import { runRead } from './vendor/modes/runner.mjs';
try {
  const [action, root, session, command, ...extra] = process.argv.slice(2);
  const s = await snapshot(root, session);
  if (!['read','write'].includes(action) || extra.length || typeof command !== 'string') throw new Error('Invalid activity read request');
  if(action === 'write') {
    if (s.activity === 'work') throw new Error('Use normal host writing tools in Work');
    process.stdout.write(JSON.stringify(applyContainedEdits(s.root,decodeEdits(command)))+'\n');
  } else process.exitCode = runRead(s.root, command);
} catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1; }
