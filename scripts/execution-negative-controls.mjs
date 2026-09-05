import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

assert.ok(process.env.DAW_EVIDENCE_DIR, 'run through npm run validate');
const results = [];
for (const [mode, expected] of [
  ['claim', 'eight simultaneous processes claim one logical owner'],
  ['fence', 'SIGSTOP stale worker cannot renew fail commit or schedule downstream after lease recovery'],
  ['expiry', 'lease checks use database time after waiting for the run lock'],
  ['recovery', 'SIGKILL after claim is recovered by restarted scheduler and production workers'],
  ['retry-limit', 'retryable failures have durable bounded attempts and backoff'],
]) {
  const directory = path.join(process.env.DAW_EVIDENCE_DIR, mode); mkdirSync(directory);
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'dist/tests/execution.test.js'], {
    env: { ...process.env, DAW_EVIDENCE_DIR: directory, DAW_EXECUTION_MUTATION: mode,
      NODE_OPTIONS: '--import=./tests/fixtures/execution-regression.mjs' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  writeFileSync(path.join(directory, 'tests.log'), output, { flag: 'wx' });
  assert.equal(code, 1, `${mode}: broken implementation must fail`);
  assert.ok(output.split('\n').some(line => line.includes('not ok') && line.includes(expected)), `${mode}: wrong failure detected`);
  results.push({ mode, exitCode: code, detectedBy: expected });
  console.log(`EXECUTION NEGATIVE CONTROL ${mode}: detected expected regression`);
}
writeFileSync(path.join(process.env.DAW_EVIDENCE_DIR, 'execution-negative-controls.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
