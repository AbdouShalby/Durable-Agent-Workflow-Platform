import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
assert.ok(process.env.DAW_EVIDENCE_DIR, 'run through npm run validate');
const results = [];
for (const [mode, expected] of [
  ['effect-key', 'eight concurrent external writes converge and reject conflicting payloads'],
  ['timeout', 'timeout remains UNKNOWN and unavailable verification never triggers blind POST'],
  ['verification', 'timeout remains UNKNOWN and unavailable verification never triggers blind POST'],
  ['unkeyed', 'unkeyed ambiguous write parks and never blindly retries'],
]) {
  const directory = path.join(process.env.DAW_EVIDENCE_DIR, 'effect-' + mode); mkdirSync(directory);
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'dist/tests/effects.test.js'], {
    env: { ...process.env, DAW_EVIDENCE_DIR: directory, DAW_EFFECT_MUTATION: mode, DAW_EFFECT_CASE: expected,
      NODE_OPTIONS: '--import=./tests/fixtures/effect-regression.mjs' }, stdio: ['ignore','pipe','pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  writeFileSync(path.join(directory, 'tests.log'), output, { flag: 'wx' });
  assert.equal(code, 1, `${mode}: broken implementation must fail`);
  assert.ok(output.split('\n').some(line => line.includes('not ok') && line.includes(expected)), `${mode}: wrong failure detected`);
  results.push({ mode, exitCode: code, detectedBy: expected });
  console.log(`EFFECT NEGATIVE CONTROL ${mode}: detected expected regression`);
}
writeFileSync(path.join(process.env.DAW_EVIDENCE_DIR, 'effect-negative-controls.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
