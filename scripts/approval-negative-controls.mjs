import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
assert.ok(process.env.DAW_EVIDENCE_DIR,'run through npm run validate');
const results=[];
for (const [mode,expected] of [
  ['fingerprint','changed action fingerprint invalidates an approved grant before dispatch'],
  ['expiry','approved grant expired before dispatch cannot authorize a POST'],
  ['authorization','operator and agent cannot grant approval at HTTP or engine boundary'],
  ['cancellation','cancellation after external authorization requires reconciliation not rollback'],
]) {
  const directory=path.join(process.env.DAW_EVIDENCE_DIR,'approval-'+mode); mkdirSync(directory);
  const child=spawn(process.execPath,['--test','--test-reporter=tap','dist/tests/approvals.test.js'],{
    env:{...process.env,DAW_EVIDENCE_DIR:directory,DAW_APPROVAL_MUTATION:mode,DAW_APPROVAL_CASE:expected,NODE_OPTIONS:'--import=./tests/fixtures/approval-regression.mjs'},stdio:['ignore','pipe','pipe'],
  });
  let output=''; child.stdout.on('data',b=>{output+=b;}); child.stderr.on('data',b=>{output+=b;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  writeFileSync(path.join(directory,'tests.log'),output,{flag:'wx'});
  assert.equal(code,1,`${mode}: broken implementation must fail`);
  assert.ok(output.split('\n').some(line=>line.includes('not ok')&&line.includes(expected)),`${mode}: wrong failure detected`);
  results.push({mode,exitCode:code,detectedBy:expected}); console.log(`APPROVAL NEGATIVE CONTROL ${mode}: detected expected regression`);
}
writeFileSync(path.join(process.env.DAW_EVIDENCE_DIR,'approval-negative-controls.json'),JSON.stringify(results,null,2)+'\n',{flag:'wx'});
