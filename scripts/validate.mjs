import './check-node.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.argv.length, 2, 'validate accepts no arguments');
assert.ok(!process.env.NODE_OPTIONS && !process.env.DAW_TEST_MUTATION && !process.env.DAW_EXECUTION_MUTATION && !process.env.DAW_EFFECT_MUTATION && !process.env.DAW_EFFECT_CASE, 'unset test mutations for the positive validation gate');
const read = f => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const hash = text => createHash('sha256').update(text).digest('hex');
const snapshot = () => Object.fromEntries([...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n'))]
  .filter(f => /^(src\/|tests\/|scripts\/|migrations\/|package(-lock)?\.json$|tsconfig\.json$|\.nvmrc$|\.npmrc$|\.github\/|compose\.yml$)/.test(f))
  .sort().map(f => [f, hash(read(f))]));
const directory = path.resolve('.local/results', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
mkdirSync(directory, { recursive: true });
const report = { schemaVersion: 1, milestone: 'DAW-3', startedAt: new Date().toISOString(), status: 'FAILED',
  gitBase: null, sourceSha256: snapshot(), runtime: { node: process.version, platform: process.platform,
    os: os.release(), arch: process.arch, temporaryRoot: os.tmpdir() }, commands: [], failures: [] };
try { report.gitBase = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Initial repository: no invented base commit. */ }
let transcript = '';
async function run(args) {
  report.commands.push(['node', ...args]);
  const child = spawn(process.execPath, args, { env: { ...process.env, DAW_EVIDENCE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; process.stdout.write(b); });
  child.stderr.on('data', b => { stderr += b; process.stderr.write(b); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  transcript += `COMMAND node ${args.join(' ')}\n${stdout}${stderr}`;
  assert.equal(code, 0, `command failed: ${args.join(' ')}`);
  return stdout;
}
try {
  await run(['--test', 'tests/secret-guard.test.mjs']);
  await run(['scripts/secret-guard.mjs']);
  await run(['node_modules/typescript/bin/tsc', '--noEmit']);
  await run(['node_modules/typescript/bin/tsc']);
  const tap = await run(['--test', '--test-reporter=tap', 'dist/tests/unit.test.js', 'dist/tests/execution-unit.test.js', 'dist/tests/effect-unit.test.js', 'dist/tests/integration.test.js', 'dist/tests/execution.test.js', 'dist/tests/effects.test.js']);
  const totals = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    assert.equal(matches.length, 1, `missing/ambiguous TAP ${key}`); totals[key] = Number(matches[0][1]);
  }
  assert.ok(totals.tests > 0); assert.equal(totals.tests, totals.pass);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(totals[key], 0);
  report.totals = totals;
  await run(['scripts/negative-controls.mjs']);
  report.negativeControls = JSON.parse(read(path.join(directory, 'negative-controls.json')));
  await run(['scripts/execution-negative-controls.mjs']);
  report.executionNegativeControls = JSON.parse(read(path.join(directory, 'execution-negative-controls.json')));
  await run(['scripts/effect-negative-controls.mjs']);
  report.effectNegativeControls = JSON.parse(read(path.join(directory, 'effect-negative-controls.json')));
  assert.deepEqual(snapshot(), report.sourceSha256, 'source changed during validation');
  report.sourceChangedDuringRun = false;
  report.integrationSha256 = hash(read(path.join(directory, 'integration.json')));
  report.executionSha256 = hash(read(path.join(directory, 'execution.json')));
  report.effectsSha256 = hash(read(path.join(directory, 'effects.json')));
  report.status = 'PASSED';
} catch (e) { report.failures.push(e.stack || String(e)); process.exitCode = 1; }
finally {
  report.completedAt = new Date().toISOString(); report.transcriptSha256 = hash(transcript);
  writeFileSync(path.join(directory, 'validation.log'), transcript, { flag: 'wx' });
  writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`VALIDATION ${path.relative(process.cwd(), directory)}/summary.json`);
}
