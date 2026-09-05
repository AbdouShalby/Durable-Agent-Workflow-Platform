import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
assert.ok(process.env.DAW_EVIDENCE_DIR, 'run through npm run validate');
const results = [];
for (const [mode, file, expected] of [
  ['output', 'agent-unit', 'agent schema rejects malformed and policy-changing output'],
  ['allowlist', 'agent-unit', 'agent tool allowlist rejects unregistered and prototype names'],
  ['checkpoint', 'agent', 'SIGKILL after accepted decision resumes without regenerating it'],
  ['budget', 'agent', 'turn budget prevents another model decision after the accepted limit'],
]) {
  const directory = path.join(process.env.DAW_EVIDENCE_DIR, 'agent-' + mode); mkdirSync(directory);
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', `dist/tests/${file}.test.js`], {
    env: { ...process.env, DAW_EVIDENCE_DIR: directory, DAW_AGENT_MUTATION: mode, DAW_AGENT_CASE: expected,
      NODE_OPTIONS: '--import=./tests/fixtures/agent-regression.mjs' }, stdio: ['ignore','pipe','pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  writeFileSync(path.join(directory, 'tests.log'), output, { flag: 'wx' });
  assert.equal(code, 1, `${mode}: broken implementation must fail`);
  assert.ok(output.split('\n').some(line => line.includes('not ok') && line.includes(expected)), `${mode}: wrong failure detected`);
  results.push({ mode, exitCode: code, detectedBy: expected });
  console.log(`AGENT NEGATIVE CONTROL ${mode}: detected expected regression`);
}
writeFileSync(path.join(process.env.DAW_EVIDENCE_DIR, 'agent-negative-controls.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
