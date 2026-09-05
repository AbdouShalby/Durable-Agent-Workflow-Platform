import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrations.js';
import { definition, definitionHash } from '../src/domain/workflow.js';
import { Lab, waitFor } from './support/lab.js';

const body = { workflow: 'incident-triage', version: 1, input: { title: 'بلاغ Café', severity: 'high' } };
interface Reply { run_id?: string; state?: string; replayed?: boolean; error?: string }
test('mandatory real PostgreSQL + independent HTTP processes; no infrastructure fallback', { timeout: 90000 }, async t => {
  const lab = new Lab();
  const evidence: Record<string, unknown> = { phase: 'RUNNING', testMutation: process.env['DAW_TEST_MUTATION'] ?? null };
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    await lab.startPostgres();
    pool = createPool(lab.url, 'daw-test-observer');
    const db = pool;
    evidence['postgres'] = (await db.query('SELECT version(), current_setting(\'fsync\') AS fsync, current_setting(\'synchronous_commit\') AS synchronous_commit')).rows[0];
    await t.test('concurrent migrations serialize and reruns preserve one checksum record per migration', async () => {
      await Promise.all([migrate(db), migrate(db)]); await migrate(db);
      assert.deepEqual((await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows,
        [{ name: '001_foundation.sql' }, { name: '002_execution.sql' }, { name: '003_effects.sql' }, { name: '004_agent.sql' }]);
    });
    const a = await lab.startApi(), b = await lab.startApi();
    assert.notEqual(a.process.child.pid, b.process.child.pid);
    const post = async (url: string, key: string, input: unknown = body) => {
      const response = await fetch(url + '/runs', { method: 'POST', headers: {
        authorization: `Bearer ${lab.token}`, 'content-type': 'application/json', 'idempotency-key': key,
      }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json() as Reply, location: response.headers.get('location') };
    };
    const counts = async (key: string) => (await db.query<{ runs: number; steps: number; ready: number; events: number }>(`
      SELECT count(*)::int AS runs,
      (SELECT count(*)::int FROM step_runs WHERE run_id IN (SELECT id FROM workflow_runs WHERE idempotency_key=$1)) AS steps,
      (SELECT count(*)::int FROM step_runs WHERE state='READY' AND run_id IN (SELECT id FROM workflow_runs WHERE idempotency_key=$1)) AS ready,
      (SELECT count(*)::int FROM run_events WHERE run_id IN (SELECT id FROM workflow_runs WHERE idempotency_key=$1)) AS events
      FROM workflow_runs WHERE idempotency_key=$1`, [key])).rows[0];
    const race = async (key: string, variants: unknown[]) => {
      const blocker = await db.connect();
      let requests: ReturnType<typeof post>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE workflow_runs IN SHARE MODE');
        requests = variants.map((value, i) => post(i % 2 ? a.url : b.url, key, value));
        // Wait for actual concurrent SQL INSERTs blocked inside independent DB sessions.
        const waiting = await waitFor(async () => {
          const rows = (await db.query<{ pid: number; wait_event: string }>(`SELECT pid,wait_event FROM pg_stat_activity
            WHERE application_name='daw-api' AND state='active' AND wait_event_type='Lock'
            AND query LIKE 'INSERT INTO workflow_runs%'`)).rows;
          return rows.length === variants.length ? rows : false;
        }, 'all concurrent inserts blocked in PostgreSQL', 6000);
        evidence[key] = { blockedBackends: waiting, apiPids: [a.process.child.pid, b.process.child.pid] };
      } finally { await blocker.query('COMMIT'); blocker.release(); }
      const results = await Promise.all(requests);
      evidence[key] = { ...(evidence[key] as object), statuses: results.map(r => r.status), responses: results.map(r => r.body) };
      return results;
    };
    let firstId = '';
    await t.test('first acceptance 202, reordered exact replay 200, changed parameters 409', async () => {
      const first = await post(a.url, 'basic'); assert.equal(first.status, 202); assert.equal(first.body.replayed, false);
      firstId = first.body.run_id ?? ''; assert.match(firstId, /^[a-f0-9-]{36}$/);
      assert.equal(first.location, `/runs/${firstId}`);
      const replay = await post(b.url, 'basic', { input: { severity: 'high', title: 'بلاغ Café' }, version: 1, workflow: 'incident-triage' });
      assert.equal(replay.status, 200); assert.equal(replay.body.run_id, firstId); assert.equal(replay.body.replayed, true);
      const conflict = await post(a.url, 'basic', { ...body, input: { ...body.input, severity: 'low' } });
      assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'idempotency_conflict');
      assert.deepEqual(await counts('basic'), { runs: 1, steps: 2, ready: 1, events: 1 });
    });
    await t.test('eight simultaneous identical requests converge; exactly one 202 and seven 200', async () => {
      const results = await race('identical-race', Array.from({ length: 8 }, () => body));
      assert.equal(results.filter(r => r.status === 202).length, 1);
      assert.equal(results.filter(r => r.status === 200 && r.body.replayed).length, 7);
      assert.equal(new Set(results.map(r => r.body.run_id)).size, 1);
      assert.deepEqual(await counts('identical-race'), { runs: 1, steps: 2, ready: 1, events: 1 });
    });
    await t.test('two simultaneous different fingerprints produce one acceptance and one conflict', async () => {
      const variants = [body, { ...body, input: { title: 'Different incident', severity: 'low' } }];
      const results = await race('conflict-race', variants);
      assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
      const winner = results.findIndex(r => r.status === 202);
      assert.equal((await post(a.url, 'conflict-race', variants[winner])).status, 200);
      assert.equal((await post(b.url, 'conflict-race', variants[1 - winner])).status, 409);
      assert.deepEqual(await counts('conflict-race'), { runs: 1, steps: 2, ready: 1, events: 1 });
    });
    await t.test('rejected payloads and missing credentials do not become durable requests', async () => {
      const invalid = [null, { ...body, version: '1' }, { ...body, extra: true },
        { ...body, input: { ...body.input, extra: true } }, { ...body, input: { title: ' ', severity: 'high' } },
        { ...body, version: 2 }, { ...body, input: { title: 'x', severity: 'critical' } }];
      for (const value of invalid) assert.equal((await post(a.url, 'invalid', value)).status, 400);
      assert.equal((await post(a.url, 'spaces forbidden')).status, 400);
      assert.equal((await fetch(a.url + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
      assert.deepEqual(await counts('invalid'), { runs: 0, steps: 0, ready: 0, events: 0 });
    });
    for (const [table, key] of [['step_runs', 'rollback-step'], ['run_events', 'rollback-event']] as const) {
      await t.test(`database failure at ${table} rolls back run, scheduling and event`, async () => {
        await db.query(`CREATE FUNCTION reject_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only write failure'; END $$`);
        await db.query(`CREATE TRIGGER reject_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_write()`);
        try {
          assert.equal((await post(a.url, key)).status, 503);
          assert.deepEqual(await counts(key), { runs: 0, steps: 0, ready: 0, events: 0 });
        } finally { await db.query(`DROP TRIGGER reject_write ON ${table}`); await db.query('DROP FUNCTION reject_write()'); }
        assert.equal((await post(a.url, key)).status, 202, 'failed transaction must not consume key');
      });
    }
    await t.test('read API and replay survive API process restart; schedule stays unexecuted', async () => {
      await lab.stop(a.process, 'SIGKILL'); await lab.stop(b.process, 'SIGKILL');
      const restarted = await lab.startApi();
      assert.equal((await post(restarted.url, 'basic')).status, 200);
      const response = await fetch(`${restarted.url}/runs/${firstId}`, { headers: { authorization: `Bearer ${lab.token}` } });
      assert.equal(response.status, 200);
      const value = await response.json() as { state: string; input: unknown; definition_hash: string; steps: { state: string; available_at: unknown }[] };
      assert.equal(value.state, 'QUEUED'); assert.deepEqual(value.input, body.input);
      assert.equal(value.definition_hash, definitionHash);
      assert.deepEqual(value.steps.map(s => s.state), definition.steps.map(s => s.state));
      assert.ok(value.steps[0]?.available_at); assert.equal(value.steps[1]?.available_at, null);
      assert.equal((await fetch(`${restarted.url}/runs/00000000-0000-4000-8000-000000000000`, { headers: { authorization: `Bearer ${lab.token}` } })).status, 404);
      assert.deepEqual(await counts('basic'), { runs: 1, steps: 2, ready: 1, events: 1 });
      await lab.stop(restarted.process);
    });
    await t.test('applied migration checksum drift is rejected, not silently accepted', async () => {
      const original = (await db.query<{ sha256: string }>("SELECT sha256 FROM schema_migrations WHERE name='001_foundation.sql'")).rows[0]?.sha256;
      assert.ok(original);
      await db.query("UPDATE schema_migrations SET sha256='changed-by-test' WHERE name='001_foundation.sql'");
      try { await assert.rejects(migrate(db), /checksum mismatch/); }
      finally { await db.query("UPDATE schema_migrations SET sha256=$1 WHERE name='001_foundation.sql'", [original]); }
    });
    await t.test('failing migration is atomic, including its schema history', async () => {
      await db.query('CREATE DATABASE migration_failure');
      const url = new URL(lab.url); url.pathname = '/migration_failure';
      const scratch = createPool(url.toString(), 'daw-migration-failure');
      const directory = path.join(lab.directory, 'failed-migrations'); await mkdir(directory);
      await writeFile(path.join(directory, '001_fail.sql'), 'CREATE TABLE must_rollback(id int); SELECT 1/0;');
      try {
        await assert.rejects(migrate(scratch, directory));
        assert.deepEqual((await scratch.query("SELECT to_regclass('must_rollback') AS data, to_regclass('schema_migrations') AS history")).rows[0], { data: null, history: null });
      } finally { await scratch.end(); }
    });
    await t.test('committed run and schedule survive PostgreSQL shutdown/restart on the same data directory', async () => {
      await db.end(); pool = undefined;
      await lab.restartPostgres();
      const restored = createPool(lab.url, 'daw-restored-observer'); pool = restored;
      const row = (await restored.query('SELECT id,input,definition FROM workflow_runs WHERE id=$1', [firstId])).rows[0] as { id: string; input: unknown; definition: unknown };
      assert.equal(row.id, firstId); assert.deepEqual(row.input, body.input); assert.deepEqual(row.definition, definition);
      assert.equal((await restored.query('SELECT * FROM step_runs WHERE run_id=$1', [firstId])).rowCount, 2);
      const restarted = await lab.startApi();
      const replay = await post(restarted.url, 'basic');
      assert.equal(replay.status, 200); assert.equal(replay.body.run_id, firstId);
      await lab.stop(restarted.process);
    });
    evidence['phase'] = 'SCENARIOS_FINISHED_SEE_TAP_FOR_VERDICT';
  } finally {
    const cleanupFailures: unknown[] = [];
    try { await pool?.end(); } catch (error) { cleanupFailures.push(error); }
    try { await lab.cleanup(); } catch (error) { cleanupFailures.push(error); }
    evidence['cleanup'] = lab.children.map(p => ({ role: p.role, pid: p.child.pid, exit: p.exit, spawnFailure: p.failure }));
    evidence['clusterDirectory'] = lab.directory;
    const directory = process.env['DAW_EVIDENCE_DIR'];
    if (directory) await writeFile(path.join(directory, 'integration.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'integration cleanup failed');
  }
});
