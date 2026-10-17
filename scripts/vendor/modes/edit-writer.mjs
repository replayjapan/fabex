// Private child entry point. The public control invokes it only inside the OS sandbox.
import { applyEdits } from './edits.mjs';
try {
  let text='';
  for await(const chunk of process.stdin) { text+=chunk; if(Buffer.byteLength(text)>256*1024) throw new Error('Research edits too large'); }
  const edits=JSON.parse(text);
  if(!Array.isArray(edits)||edits.length>16) throw new Error('Invalid research edit batch');
  process.stdout.write(JSON.stringify(applyEdits(process.argv[2],edits))+'\n');
} catch(e) { process.stderr.write(e.message+'\n'); process.exitCode=1; }
