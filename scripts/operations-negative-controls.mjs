import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
assert.ok(process.env.DAW_EVIDENCE_DIR,'run through npm run validate');
const results=[];
for(const [mode,expected] of [
 ['outage','PostgreSQL outage rejects admission and recovers a real workers lost lease'],
 ['readiness','readiness rejects unavailable database and mismatched schema while liveness stays alive'],
 ['shutdown','worker shutdown deadline forces exit and lease recovery'],
 ['capacity','HTTP handler capacity rejects overflow without exceeding the database pool'],
 ['telemetry','operational telemetry has bounded fields and exposes durable retry recovery signals'],
]) {
 const directory=path.join(process.env.DAW_EVIDENCE_DIR,'operations-'+mode);mkdirSync(directory);
 const child=spawn(process.execPath,['--test','--test-reporter=tap','dist/tests/operations.test.js'],{
  env:{...process.env,DAW_EVIDENCE_DIR:directory,DAW_OPERATIONS_MUTATION:mode,DAW_OPERATIONS_CASE:expected,NODE_OPTIONS:'--import=./tests/fixtures/operations-regression.mjs'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 writeFileSync(path.join(directory,'tests.log'),output,{flag:'wx'});
 assert.equal(code,1,`${mode}: broken safeguard must fail`);
 assert.ok(output.split('\n').some(l=>l.includes('not ok')&&l.includes(expected)),`${mode}: incorrect witness`);
 results.push({mode,exitCode:code,detectedBy:expected});console.log(`OPERATIONS NEGATIVE CONTROL ${mode}: detected expected regression`);
}
writeFileSync(path.join(process.env.DAW_EVIDENCE_DIR,'operations-negative-controls.json'),JSON.stringify(results,null,2)+'\n',{flag:'wx'});
