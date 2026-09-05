import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { createPool } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrations.js';
import { createRun } from '../src/application/runs.js';
import type { Claim } from '../src/application/execution.js';
import { retryDelay } from '../src/domain/retry.js';
import { Lab, waitFor } from './support/lab.js';
import type { OwnedProcess } from './support/lab.js';

const request = { workflow: 'incident-triage', version: 1, input: { title: '  incident  ', severity: 'high' } } as const;
interface Message { id?: string; value?: unknown; error?: string; ready?: boolean; held?: Claim }
interface Actor { process: OwnedProcess; messages: Message[]; call: (action: string, options?: object) => Promise<unknown> }

test('DAW-2 real PostgreSQL execution, process contention and failure windows', { timeout: 180000 }, async t => {
  const lab = new Lab();
  const evidence: Record<string, unknown> = { phase: 'RUNNING', mutation: process.env['DAW_EXECUTION_MUTATION'] ?? null, cases: {} };
  const cases = evidence['cases'] as Record<string, unknown>;
  let admin: pg.Pool | undefined;
  const actor = async (url: string): Promise<Actor> => {
    const owned = lab.child('execution-actor', process.execPath, ['dist/tests/support/execution-actor.js'], { ...process.env, DATABASE_URL: url }, true);
    const messages: Message[] = [];
    owned.child.on('message', message => messages.push(message as Message));
    await waitFor(() => messages.some(m => m.ready), 'actor ready');
    return { process: owned, messages, call: async (action, options = {}) => {
      const id = randomUUID(); owned.child.send?.({ id, action, ...options });
      const reply = await waitFor(() => {
        if (owned.exit || owned.failure) throw new Error(`actor exited: ${owned.output}`);
        return messages.find(m => m.id === id) ?? false;
      }, `actor ${action}`, 15000);
      if (reply.error) throw new Error(reply.error);
      return reply.value;
    } };
  };
  const runCase = async (name: string, body: (db: pg.Pool, url: string, run: string, record: Record<string, unknown>) => Promise<void>, foundationOnly = false) => {
    await t.test(name, async () => {
      assert.ok(admin);
      const dbName = 'case_' + randomUUID().replaceAll('-', '');
      await admin.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(lab.url); url.pathname = '/' + dbName;
      const db = createPool(url.toString(), 'daw-execution-observer');
      const start = lab.children.length;
      const record: Record<string, unknown> = {}; cases[name] = record;
      try {
        if (foundationOnly) {
          const initial = path.join(lab.directory, dbName); await mkdir(initial);
          await copyFile('migrations/001_foundation.sql', path.join(initial, '001_foundation.sql'));
          await migrate(db, initial);
        } else await migrate(db);
        const { run } = await createRun(db, 'local-operator', 'execution', request);
        await body(db, url.toString(), run.id, record);
        record['steps'] = (await db.query('SELECT step_key,state,attempt_count,fence,result,last_error FROM step_runs ORDER BY ordinal')).rows;
        record['attempts'] = (await db.query('SELECT * FROM step_attempts ORDER BY step_key,attempt')).rows;
        record['events'] = (await db.query('SELECT sequence,type,details FROM run_events ORDER BY sequence')).rows;
      } finally {
        const failures: unknown[] = [];
        try { await db.end(); } catch (error) { failures.push(error); }
        for (const child of lab.children.slice(start).reverse()) {
          try {
            if (!child.exit) child.child.kill('SIGCONT');
            await lab.stop(child, 'SIGTERM');
          } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'execution case cleanup failed');
      }
    });
  };
  const state = async (db: pg.Pool, run: string) => (await db.query<{ state: string }>('SELECT state FROM workflow_runs WHERE id=$1', [run])).rows[0]?.state;
  const expired = async (db: pg.Pool) => waitFor(async () => (await db.query("SELECT 1 FROM step_runs WHERE state='RUNNING' AND lease_expires_at<=clock_timestamp()")).rowCount === 1, 'real database lease expiration');
  const ready = async (db: pg.Pool) => waitFor(async () => (await db.query("SELECT 1 FROM step_runs WHERE state='READY'")).rowCount === 1, 'recovery made step ready');
  const daemon = async (role: 'worker' | 'scheduler', url: string) => {
    const owned = lab.child(role, process.execPath, [`dist/src/entrypoints/${role}.js`], { ...process.env, DATABASE_URL: url });
    await waitFor(() => {
      if (owned.exit || owned.failure) throw new Error(owned.output);
      return owned.output.includes('"event":"started"');
    }, `${role} started`);
    return owned;
  };
  try {
    await lab.startPostgres(); admin = createPool(lab.url, 'daw-execution-admin');
    evidence['postgres'] = (await admin.query("SELECT version(),current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit")).rows[0];

    await runCase('eight simultaneous processes claim one logical owner', async (db, url, run, record) => {
      const actors = await Promise.all(Array.from({ length: 8 }, () => actor(url)));
      const blocker = await db.connect(); let pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE');
        pending = actors.map(a => a.call('claim'));
        const blocked = await waitFor(async () => {
          const rows = (await db.query(`SELECT pid,query,wait_event FROM pg_stat_activity WHERE application_name='daw-execution-actor'
            AND state='active' AND wait_event_type='Lock'`)).rows;
          return rows.length === 8 ? rows : false;
        }, 'eight simultaneous claim SQL sessions');
        record['blockedSessions'] = blocked; record['processPids'] = actors.map(a => a.process.child.pid);
        assert.equal(new Set(actors.map(a => a.process.child.pid)).size, 8);
      } finally { await blocker.query('COMMIT'); blocker.release(); }
      const claims = await Promise.all(pending);
      assert.equal(claims.filter(Boolean).length, 1); record['claimResults'] = claims;
      assert.equal((await db.query('SELECT * FROM step_attempts')).rowCount, 1);
      const winner = actors[claims.findIndex(Boolean)]!;
      const before = (await db.query('SELECT count(*)::int AS n FROM run_events')).rows;
      assert.equal(await actors[(claims.findIndex(Boolean) + 1) % 8]!.call('recover'), false);
      assert.deepEqual((await db.query('SELECT count(*)::int AS n FROM run_events')).rows, before);
      assert.equal(await winner.call('complete', { result: { title: 'incident', severity: 'high' } }), true);
      const events = (await db.query('SELECT * FROM run_events')).rowCount;
      assert.equal(await winner.call('complete', { result: 'duplicate' }), false);
      assert.equal((await db.query('SELECT * FROM run_events')).rowCount, events);
      assert.equal(await state(db, run), 'RUNNING');
    });

    await runCase('SIGSTOP stale worker cannot renew fail commit or schedule downstream after lease recovery', async (db, url, run, record) => {
      await db.query('UPDATE step_runs SET lease_ms=600');
      const old = await actor(url), fresh = await actor(url);
      const first = await old.call('claim') as Claim;
      assert.equal(old.process.child.kill('SIGSTOP'), true);
      try {
        await expired(db);
        const reconcilers = await Promise.all([actor(url), actor(url)]);
        const barrier = await db.connect(); let recovery: Promise<unknown>[] = [];
        try {
          await barrier.query('BEGIN'); await barrier.query('LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE');
          recovery = reconcilers.map(a => a.call('recover'));
          record['recoveryBlockedSessions'] = await waitFor(async () => {
            const rows = (await db.query(`SELECT pid,wait_event FROM pg_stat_activity WHERE application_name='daw-execution-actor'
              AND state='active' AND wait_event_type='Lock'`)).rows;
            return rows.length === 2 ? rows : false;
          }, 'two concurrent recovery SQL sessions');
        } finally { await barrier.query('COMMIT'); barrier.release(); }
        assert.deepEqual((await Promise.all(recovery)).sort(), [false, true]);
        // Real scheduler entrypoints now release the persisted retry when due.
        const schedulers = await Promise.all([daemon('scheduler', url), daemon('scheduler', url)]);
        await ready(db); for (const scheduler of schedulers) await lab.stop(scheduler);
        const second = await fresh.call('claim') as Claim;
        assert.equal(second.fence, first.fence + 1); assert.equal(second.run_id, run);
        assert.equal(old.process.child.kill('SIGCONT'), true);
        const snapshot = (await db.query('SELECT step_key,state,fence,result FROM step_runs ORDER BY ordinal')).rows;
        assert.equal(await old.call('renew'), false);
        assert.equal(await old.call('fail'), false);
        assert.equal(await old.call('complete', { result: 'stale' }), false);
        assert.deepEqual((await db.query('SELECT step_key,state,fence,result FROM step_runs ORDER BY ordinal')).rows, snapshot);
        assert.equal(await fresh.call('complete', { result: { title: 'incident', severity: 'high' } }), true);
        assert.equal((await db.query("SELECT * FROM run_events WHERE type='RETRY_SCHEDULED'")).rowCount, 1);
        assert.equal((await db.query("SELECT * FROM run_events WHERE type='RETRY_READY'")).rowCount, 1);
        record['oldFence'] = first.fence; record['newFence'] = second.fence;
      } finally { if (!old.process.exit) old.process.child.kill('SIGCONT'); }
    });

    await runCase('lease checks use database time after waiting for the run lock', async (db, url) => {
      await db.query('UPDATE step_runs SET lease_ms=600');
      const worker = await actor(url); await worker.call('claim');
      const blocker = await db.connect(); let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM workflow_runs FOR UPDATE');
        pending = worker.call('complete', { result: 'late' });
        await expired(db);
      } finally { await blocker.query('COMMIT'); blocker.release(); }
      assert.equal(await pending, false);
      assert.equal(await worker.call('renew'), false);
      assert.equal((await db.query("SELECT * FROM step_runs WHERE state='SUCCEEDED'")).rowCount, 0);
    });

    await runCase('SIGKILL after claim is recovered by restarted scheduler and production workers', async (db, url, run, record) => {
      await db.query('UPDATE step_runs SET lease_ms=600');
      const killed = await actor(url); await killed.call('claim'); await lab.stop(killed.process, 'SIGKILL');
      await expired(db);
      const one = await actor(url); assert.equal(await one.call('recover'), true); await lab.stop(one.process, 'SIGKILL');
      const scheduled = (await db.query("SELECT available_at FROM step_runs WHERE state='RETRY_WAIT'")).rows[0];
      assert.ok(scheduled); record['persistedScheduleBeforeRestart'] = scheduled;
      const scheduler = await daemon('scheduler', url);
      const workers = await Promise.all([daemon('worker', url), daemon('worker', url)]);
      await waitFor(async () => await state(db, run) === 'SUCCEEDED', 'recovered run completes');
      for (const process of [...workers, scheduler]) await lab.stop(process);
      const steps = (await db.query('SELECT result,attempt_count FROM step_runs ORDER BY ordinal')).rows;
      assert.deepEqual(steps, [{ result: { title: 'incident', severity: 'high' }, attempt_count: 2 }, { result: '[HIGH] incident', attempt_count: 1 }]);
      const replay = await createRun(db, 'local-operator', 'execution', request);
      assert.equal(replay.created, false); assert.equal(replay.run.id, run); assert.equal(replay.run.state, 'SUCCEEDED');
      const unused = await actor(url); assert.equal(await unused.call('claim'), null);
    });

    await runCase('retryable failures have durable bounded attempts and backoff', async (db, url, run, record) => {
      const worker = await actor(url), scheduler = await actor(url);
      for (let attempt = 1; attempt <= 3; attempt++) {
        assert.equal(await worker.call('retry'), true);
        const row = (await db.query('SELECT outcome,retry_delay_ms FROM step_attempts WHERE attempt=$1', [attempt])).rows[0] as { outcome: string; retry_delay_ms: number | null };
        assert.equal(row.outcome, 'RETRYABLE');
        if (attempt < 3) {
          assert.equal(row.retry_delay_ms, retryDelay(run, 'normalize-incident', attempt, 200, 2000));
          assert.equal(await worker.call('claim'), null);
          await waitFor(async () => (await db.query("SELECT 1 FROM step_runs WHERE state='RETRY_WAIT' AND available_at<=clock_timestamp()")).rowCount === 1, 'persisted retry due');
          assert.equal(await scheduler.call('recover'), true);
        } else assert.equal(row.retry_delay_ms, null);
      }
      assert.equal(await state(db, run), 'FAILED');
      assert.equal(await worker.call('claim'), null); assert.equal(await scheduler.call('recover'), false);
      assert.equal((await db.query('SELECT * FROM step_attempts')).rowCount, 3); record['attemptLimit'] = 3;
      assert.equal((await db.query("SELECT state FROM step_runs WHERE ordinal=1")).rows[0]?.state, 'BLOCKED');
    });

    await runCase('repeated hard crashes exhaust the same durable attempt budget', async (db, url, run) => {
      await db.query('UPDATE step_runs SET lease_ms=500,max_attempts=2');
      const scheduler = await actor(url);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const worker = await actor(url); assert.equal((await worker.call('claim') as Claim).attempt_count, attempt);
        await lab.stop(worker.process, 'SIGKILL'); await expired(db); assert.equal(await scheduler.call('recover'), true);
        if (attempt === 1) {
          await waitFor(async () => await scheduler.call('recover') === true, 'retry becomes ready');
        }
      }
      assert.equal(await state(db, run), 'FAILED');
      assert.deepEqual((await db.query('SELECT outcome FROM step_attempts ORDER BY attempt')).rows, [{ outcome: 'EXPIRED' }, { outcome: 'EXPIRED' }]);
      assert.equal(await scheduler.call('claim'), null); assert.equal(await scheduler.call('recover'), false);
    });

    await runCase('heartbeat preserves active ownership but cannot extend the hard deadline', async (db, url, run, record) => {
      await db.query('UPDATE step_runs SET lease_ms=500,max_elapsed_ms=1800');
      const worker = await actor(url), other = await actor(url);
      const running = worker.call('hold');
      const held = await waitFor(() => worker.messages.find(m => m.held)?.held ?? false, 'executor held with heartbeat');
      const renewed = await waitFor(async () => {
        const row = (await db.query("SELECT lease_expires_at,deadline_at FROM step_runs WHERE state='RUNNING'")).rows[0] as { lease_expires_at: Date; deadline_at: Date };
        return row.lease_expires_at.getTime() > new Date(held.lease_expires_at).getTime() + 150 ? row : false;
      }, 'real worker heartbeat extended lease');
      assert.ok(renewed.lease_expires_at <= renewed.deadline_at);
      assert.equal(await other.call('claim'), null); assert.equal(await other.call('recover'), false);
      await expired(db); assert.equal(await other.call('recover'), true);
      await worker.call('release'); await running;
      assert.equal(await state(db, run), 'FAILED');
      assert.equal((await db.query("SELECT * FROM step_runs WHERE state='SUCCEEDED'")).rowCount, 0);
      record['initialLease'] = held.lease_expires_at; record['renewedLease'] = renewed;
    });

    await runCase('result downstream scheduling and events roll back together on database failure', async (db, url) => {
      const worker = await actor(url); await worker.call('claim');
      await db.query(`CREATE FUNCTION reject_execution_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='STEP_SUCCEEDED' THEN RAISE EXCEPTION 'test-only event failure'; END IF; RETURN NEW; END $$`);
      await db.query('CREATE TRIGGER reject_execution_event BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_execution_event()');
      try {
        await assert.rejects(worker.call('complete', { result: { title: 'incident', severity: 'high' } }), /test-only event failure/);
        assert.deepEqual((await db.query('SELECT state,result FROM step_runs ORDER BY ordinal')).rows,
          [{ state: 'RUNNING', result: null }, { state: 'BLOCKED', result: null }]);
        assert.equal((await db.query('SELECT outcome FROM step_attempts')).rows[0]?.outcome, 'RUNNING');
      } finally { await db.query('DROP TRIGGER reject_execution_event ON run_events'); await db.query('DROP FUNCTION reject_execution_event()'); }
      assert.equal(await worker.call('complete', { result: { title: 'incident', severity: 'high' } }), true);
    });

    await runCase('locked run does not block another run and committed prior results are reused after worker crash', async (db, url, run) => {
      const second = (await createRun(db, 'local-operator', 'second', request)).run.id;
      const blocker = await db.connect(); const worker = await actor(url);
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE', [run]);
        assert.equal((await worker.call('claim') as Claim).run_id, second);
      } finally { await blocker.query('COMMIT'); blocker.release(); }
      assert.equal(await worker.call('complete', { result: { title: 'saved result', severity: 'low' } }), true);
      await lab.stop(worker.process, 'SIGKILL');
      const resumed = await daemon('worker', url);
      await waitFor(async () => await state(db, second) === 'SUCCEEDED' && await state(db, run) === 'SUCCEEDED', 'independent runs finish');
      await lab.stop(resumed);
      assert.deepEqual((await db.query('SELECT attempt_count,result FROM step_runs WHERE run_id=$1 ORDER BY ordinal', [second])).rows,
        [{ attempt_count: 1, result: { title: 'saved result', severity: 'low' } }, { attempt_count: 1, result: '[LOW] saved result' }]);
    });

    for (const pending of ['READY', 'RETRY_WAIT']) await runCase(`deadline expiration while ${pending} becomes terminal without another attempt`, async (db, url, run) => {
      await db.query('UPDATE step_runs SET lease_ms=500,max_elapsed_ms=1000');
      const worker = await actor(url); await worker.call('claim'); assert.equal(await worker.call('fail'), true);
      if (pending === 'READY') await waitFor(async () => await worker.call('recover') === true, 'retry ready before deadline');
      await waitFor(async () => (await db.query('SELECT 1 FROM step_runs WHERE deadline_at<=clock_timestamp()')).rowCount === 1, 'persisted step deadline');
      assert.equal(await worker.call('claim'), null); assert.equal(await worker.call('recover'), true);
      assert.equal(await state(db, run), 'FAILED'); assert.equal((await db.query('SELECT * FROM step_attempts')).rowCount, 1);
    });

    await runCase('DAW-1 queued rows upgrade without invented attempts and execute with their original identity', async (db, url, run) => {
      const original = (await db.query('SELECT id,input,definition_hash,request_fingerprint FROM workflow_runs')).rows;
      await migrate(db); await migrate(db);
      assert.deepEqual((await db.query('SELECT id,input,definition_hash,request_fingerprint FROM workflow_runs')).rows, original);
      assert.deepEqual((await db.query('SELECT state,attempt_count,fence,deadline_at FROM step_runs ORDER BY ordinal')).rows,
        [{ state: 'READY', attempt_count: 0, fence: 0, deadline_at: null }, { state: 'BLOCKED', attempt_count: 0, fence: 0, deadline_at: null }]);
      assert.equal((await db.query('SELECT * FROM step_attempts')).rowCount, 0);
      const worker = await daemon('worker', url);
      await waitFor(async () => await state(db, run) === 'SUCCEEDED', 'upgraded run completes'); await lab.stop(worker);
      assert.equal((await createRun(db, 'local-operator', 'execution', request)).run.id, run);
    }, true);

    await runCase('unsupported pinned definition fails permanently without releasing downstream', async (db, url, run) => {
      await db.query('UPDATE workflow_runs SET workflow_version=2');
      const worker = await daemon('worker', url);
      await waitFor(async () => await state(db, run) === 'FAILED', 'unsupported workflow fails'); await lab.stop(worker);
      assert.equal((await db.query('SELECT outcome FROM step_attempts')).rows[0]?.outcome, 'PERMANENT');
      assert.equal((await db.query("SELECT state FROM step_runs WHERE ordinal=1")).rows[0]?.state, 'BLOCKED');
    });
    evidence['phase'] = 'SCENARIOS_FINISHED_SEE_TAP_FOR_VERDICT';
  } finally {
    const failures: unknown[] = [];
    try { await admin?.end(); } catch (error) { failures.push(error); }
    try { await lab.cleanup(); } catch (error) { failures.push(error); }
    evidence['cleanup'] = lab.children.map(p => ({ role: p.role, pid: p.child.pid, exit: p.exit, spawnFailure: p.failure }));
    evidence['clusterDirectory'] = lab.directory;
    const directory = process.env['DAW_EVIDENCE_DIR'];
    if (directory) await writeFile(path.join(directory, 'execution.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    if (failures.length) throw new AggregateError(failures, 'execution cleanup failed');
  }
});
