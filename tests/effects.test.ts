import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { createPool } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrations.js';
import { createRun, IdempotencyConflict } from '../src/application/runs.js';
import { claimStep, completeStep, recoverOne } from '../src/application/execution.js';
import { runOne } from '../src/application/worker.js';
import { effectFingerprint } from '../src/domain/effect.js';
import type { Claim } from '../src/application/execution.js';
import type { EffectContract } from '../src/domain/effect.js';
import { Lab, waitFor } from './support/lab.js';
import type { OwnedProcess } from './support/lab.js';

const input = { title: ' representative incident ', severity: 'high' } as const;
interface Case {
  db: pg.Pool; external: pg.Pool; run: string; url: string; serviceId: string;
  restart: (fault: string) => Promise<void>; stopService: () => Promise<void>; record: Record<string, unknown>;
}
test('DAW-3 independent external effects and conservative reconciliation', { timeout: 180000 }, async t => {
  const platform = new Lab(), provider = new Lab();
  let platformAdmin: pg.Pool | undefined, providerAdmin: pg.Pool | undefined;
  const cases: Record<string, unknown> = {};
  const record: Record<string, unknown> = { mutation: process.env['DAW_EFFECT_MUTATION'] ?? null, cases };
  const actor = async (url: string) => {
    const owned = platform.child('effect-actor', process.execPath, ['dist/tests/support/effect-actor.js'], { ...process.env, DATABASE_URL: url }, true);
    const messages: { id?: string; ready?: boolean; value?: unknown; error?: boolean }[] = [];
    owned.child.on('message', m => messages.push(m as typeof messages[number]));
    await waitFor(() => messages.some(m => m.ready), 'effect actor ready');
    return { owned, call: async (action: string, receipt?: unknown) => {
      const id = randomUUID(); owned.child.send?.({ id, action, receipt });
      const reply = await waitFor(() => {
        if (owned.exit || owned.failure) throw new Error('actor exited');
        return messages.find(m => m.id === id) ?? false;
      }, action);
      if (reply.error) throw new Error('actor operation failed');
      return reply.value;
    } };
  };
  const retry = async (db: pg.Pool) => {
    await waitFor(async () => { await recoverOne(db); return (await db.query("SELECT 1 FROM step_runs WHERE step_key='write-summary' AND state='READY'")).rowCount === 1; }, 'effect retry ready');
  };
  const tool = async (db: pg.Pool) => (await db.query('SELECT * FROM tool_invocations')).rows[0];
  const count = async (db: pg.Pool, table: 'external_writes' | 'external_requests', method?: string): Promise<number> =>
    Number((await db.query(`SELECT count(*) AS n FROM ${table}${method ? ' WHERE method=$1' : ''}`, method ? [method] : [])).rows[0]?.n);
  const runCase = async (name: string, contract: EffectContract, fault: string, body: (context: Case) => Promise<void>) => {
    // Negative controls execute only their named witness. Positive gates disallow this selector.
    const selected = process.env['DAW_EFFECT_CASE'];
    if (selected && !process.env['DAW_EFFECT_MUTATION']) throw new Error('case selection requires an explicit mutation');
    if (selected && selected !== name) return;
    await t.test(name, async () => {
      assert.ok(platformAdmin && providerAdmin);
      const database = 'effect_' + randomUUID().replaceAll('-', '');
      await platformAdmin.query(`CREATE DATABASE ${database}`); await providerAdmin.query(`CREATE DATABASE ${database}`);
      const dbUrl = new URL(platform.url); dbUrl.pathname = '/' + database;
      const extUrl = new URL(provider.url); extUrl.pathname = '/' + database;
      const db = createPool(dbUrl.href, 'daw-effect-observer'), external = createPool(extUrl.href, 'daw-external-observer');
      let service: OwnedProcess | undefined, endpoint = '';
      const serviceId = randomUUID(), start = platform.children.length;
      const evidence: Record<string, unknown> = {}; cases[name] = evidence;
      const restart = async (mode: string) => {
        if (service) await provider.stop(service);
        service = provider.child('external-http', process.execPath, ['dist/src/simulator/server.js'], {
          ...process.env, SIMULATOR_DATABASE_URL: extUrl.href, SIMULATOR_SERVICE_ID: serviceId,
          SIMULATOR_PORT: endpoint ? new URL(endpoint).port : '0', SIMULATOR_FAULT: mode,
        });
        const owned = service;
        endpoint = await waitFor(() => {
          if (owned.exit || owned.failure) throw new Error('simulator startup failed: ' + owned.output);
          const line = owned.output.split('\n').find(line => line.startsWith('{'));
          return line ? (JSON.parse(line) as { url: string }).url : false;
        }, 'independent simulator listening');
      };
      try {
        await migrate(db); await restart(fault);
        process.env['EFFECT_SERVICE_URL'] = endpoint; process.env['EFFECT_SERVICE_ID'] = serviceId;
        const { run } = await createRun(db, 'local-operator', 'effect', { workflow: 'incident-triage', version: 2, input, toolContract: contract });
        await runOne(db, randomUUID()); await runOne(db, randomUUID());
        assert.equal((await db.query("SELECT state FROM step_runs WHERE step_key='write-summary'")).rows[0]?.state, 'READY');
        evidence['run'] = run.id; evidence['serviceId'] = serviceId;
        await body({ db, external, run: run.id, url: dbUrl.href, serviceId, restart,
          stopService: async () => { if (service) await provider.stop(service); }, record: evidence });
      } finally {
        const failures: unknown[] = [];
        for (const p of platform.children.slice(start).reverse()) {
          try { if (!p.exit) p.child.kill('SIGCONT'); await platform.stop(p); } catch (e) { failures.push(e); }
        }
        try {
          evidence['tools'] = (await db.query('SELECT effect_key,contract,state,sends,verifications,receipt FROM tool_invocations')).rows;
          evidence['steps'] = (await db.query('SELECT step_key,state,attempt_count,fence,result,last_error FROM step_runs ORDER BY ordinal')).rows;
          evidence['events'] = (await db.query('SELECT sequence,type,details FROM run_events ORDER BY sequence')).rows;
          evidence['externalWrites'] = (await external.query('SELECT * FROM external_writes ORDER BY id')).rows;
          evidence['externalRequests'] = (await external.query('SELECT * FROM external_requests ORDER BY id')).rows;
        } catch (e) { failures.push(e); }
        for (const close of [() => db.end(), () => external.end(), () => service ? provider.stop(service) : Promise.resolve()]) {
          try { await close(); } catch (e) { failures.push(e); }
        }
        if (failures.length) throw new AggregateError(failures, 'effect case cleanup/evidence failed');
      }
    });
  };
  try {
    await platform.startPostgres(); await provider.startPostgres();
    assert.notEqual(platform.directory, provider.directory); assert.notEqual(platform.postgres?.child.pid, provider.postgres?.child.pid);
    platformAdmin = createPool(platform.url, 'platform-admin'); providerAdmin = createPool(provider.url, 'provider-admin');
    record['independentClusters'] = [platform.directory, provider.directory];
    record['postgres'] = await Promise.all([platformAdmin,providerAdmin].map(async db => (await db.query("SELECT version(),current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit")).rows[0]));

    await runCase('eight concurrent external writes converge and reject conflicting payloads', 'keyed', 'normal', async ({ db, external, serviceId, record }) => {
      const invocation = await tool(db), blocker = await external.connect();
      const headers = { 'content-type': 'application/json', 'x-service-id': serviceId };
      const post = (payload: { summary: string }) => fetch(invocation.service_url + '/effects/keyed', { method: 'POST', headers,
        body: JSON.stringify({ effectKey: invocation.effect_key, request: payload, requestFingerprint: effectFingerprint(payload) }) });
      let pending: Promise<Response>[] = [];
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE external_writes IN ACCESS EXCLUSIVE MODE');
        pending = Array.from({ length: 8 }, () => post(invocation.request));
        const blocked = await waitFor(async () => {
          const rows = (await external.query("SELECT pid,wait_event FROM pg_stat_activity WHERE application_name='daw-independent-simulator' AND state='active' AND wait_event_type='Lock'")).rows;
          return rows.length === 8 ? rows : false;
        }, 'eight simultaneous external transactions');
        record['blockedExternalSessions'] = blocked;
      } finally { await blocker.query('COMMIT'); blocker.release(); }
      const responses = await Promise.all(pending); assert.ok(responses.every(r => r.status === 200));
      const receipts = await Promise.all(responses.map(r => r.json()));
      assert.ok(receipts.every(r => JSON.stringify(r) === JSON.stringify(receipts[0])));
      assert.equal(await count(external, 'external_writes'), 1);
      assert.equal((await post({ summary: 'different request' })).status, 409);
      await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'VERIFIED'); assert.equal(await count(external, 'external_writes'), 1);
    });

    await runCase('SIGKILL after external commit recovers by receipt without another POST', 'keyed', 'hold-response', async ({ db, external, url, restart, record }) => {
      await db.query("UPDATE step_runs SET lease_ms=600 WHERE step_key='write-summary'");
      const worker = await actor(url);
      const pending = worker.call('run').catch(() => undefined);
      await waitFor(async () => await count(external, 'external_writes') === 1, 'external commit before response');
      assert.equal((await tool(db)).state, 'UNKNOWN');
      await platform.stop(worker.owned, 'SIGKILL'); await pending;
      assert.equal(worker.owned.exit?.signal, 'SIGKILL'); record['killedPid'] = worker.owned.child.pid;
      await restart('normal'); await retry(db);
      const daemon = platform.child('worker', process.execPath, ['dist/src/entrypoints/worker.js'], { ...process.env, DATABASE_URL: url });
      await waitFor(async () => (await db.query('SELECT state FROM workflow_runs')).rows[0]?.state === 'SUCCEEDED', 'real worker reconciles receipt');
      await platform.stop(daemon);
      assert.equal(await count(external, 'external_requests', 'POST'), 1);
      assert.equal(await count(external, 'external_requests', 'GET'), 1);
      assert.equal(await count(external, 'external_writes'), 1);
      assert.equal((await db.query("SELECT attempt_count FROM step_runs WHERE step_key='write-summary'")).rows[0]?.attempt_count, 2);
    });

    await runCase('timeout remains UNKNOWN and unavailable verification never triggers blind POST', 'keyed', 'hold-response', async ({ db, external, restart }) => {
      await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'UNKNOWN');
      assert.equal((await db.query("SELECT state FROM step_runs WHERE step_key='write-summary'")).rows[0]?.state, 'RETRY_WAIT');
      await restart('lookup-unavailable'); await retry(db); await runOne(db, randomUUID());
      assert.equal(await count(external, 'external_requests', 'POST'), 1);
      assert.equal((await tool(db)).state, 'UNKNOWN');
      await restart('normal'); await retry(db); await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'VERIFIED'); assert.equal(await count(external, 'external_writes'), 1);
    });

    await runCase('unkeyed ambiguous write parks and never blindly retries', 'unkeyed', 'hold-response', async ({ db, external, restart }) => {
      await runOne(db, randomUUID()); await restart('normal');
      assert.equal((await tool(db)).state, 'UNKNOWN');
      assert.equal((await db.query('SELECT state FROM workflow_runs')).rows[0]?.state, 'RECONCILIATION_REQUIRED');
      for (let i = 0; i < 4; i++) { assert.equal(await recoverOne(db), false); assert.equal(await runOne(db, randomUUID()), false); }
      assert.equal(await count(external, 'external_requests', 'POST'), 1);
      assert.equal(await count(external, 'external_writes'), 1);
    });

    await runCase('receipt verification rejects mismatched response and later verifies independently', 'keyed', 'bad-receipt', async ({ db, external, restart }) => {
      await runOne(db, randomUUID()); assert.equal((await tool(db)).state, 'UNKNOWN'); assert.equal((await tool(db)).receipt, null);
      await restart('normal'); await retry(db); await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'VERIFIED'); assert.equal(await count(external, 'external_requests', 'POST'), 1);
    });

    await runCase('independent write survives platform receipt transaction rollback', 'keyed', 'normal', async ({ db, external }) => {
      await db.query(`CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='EFFECT_VERIFIED' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER receipt_failure BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_receipt();`);
      await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'UNKNOWN'); assert.equal((await tool(db)).receipt, null);
      assert.equal(await count(external, 'external_writes'), 1);
      await db.query('DROP TRIGGER receipt_failure ON run_events'); await retry(db); await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'VERIFIED'); assert.equal(await count(external, 'external_requests', 'POST'), 1);
    });

    await runCase('preparation database failure leaves lease recovery rather than permanent failure', 'keyed', 'normal', async ({ db, external }) => {
      await db.query(`CREATE FUNCTION reject_preparation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='EFFECT_UNKNOWN' THEN RAISE EXCEPTION 'injected preparation failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER preparation_failure BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_preparation();`);
      await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'PREPARED');
      assert.equal((await db.query("SELECT state FROM step_runs WHERE step_key='write-summary'")).rows[0]?.state, 'RUNNING');
      assert.equal(await count(external, 'external_requests'), 0);
      await db.query('DROP TRIGGER preparation_failure ON run_events');
      await retry(db); await runOne(db, randomUUID());
      assert.equal((await tool(db)).state, 'VERIFIED'); assert.equal(await count(external, 'external_writes'), 1);
    });

    await runCase('SIGKILL after VERIFIED receipt completes offline without another external request', 'unkeyed', 'normal', async ({ db, external, url, stopService, record }) => {
      await db.query("UPDATE step_runs SET lease_ms=600 WHERE step_key='write-summary'");
      const worker = await actor(url); await worker.call('claim'); await worker.call('execute');
      const saved = (await tool(db)).receipt; assert.ok(saved); assert.equal((await tool(db)).state, 'VERIFIED');
      assert.equal((await db.query("SELECT state FROM step_runs WHERE step_key='write-summary'")).rows[0]?.state, 'RUNNING');
      await platform.stop(worker.owned, 'SIGKILL'); record['killedPidAfterReceipt'] = worker.owned.child.pid;
      const requests = await count(external, 'external_requests'); await stopService(); await retry(db);
      await runOne(db, randomUUID());
      assert.equal((await db.query('SELECT state FROM workflow_runs')).rows[0]?.state, 'SUCCEEDED');
      assert.deepEqual((await tool(db)).receipt, saved);
      assert.equal(await count(external, 'external_requests'), requests); assert.equal(await count(external, 'external_writes'), 1);
    });

    for (const waitingState of ['RETRY_WAIT','READY']) {
      await runCase(`deadline expiry parks UNKNOWN from ${waitingState}`, 'keyed', 'hold-response', async ({ db, external }) => {
        await runOne(db, randomUUID()); assert.equal((await tool(db)).state, 'UNKNOWN');
        if (waitingState === 'READY') await retry(db);
        // Persist a short remaining deadline; observe actual PostgreSQL time passing, never a fake clock.
        await db.query("UPDATE step_runs SET deadline_at=clock_timestamp()+interval '100 milliseconds',available_at=clock_timestamp()+interval '10 seconds' WHERE step_key='write-summary'");
        await waitFor(async () => { await recoverOne(db); return (await db.query('SELECT state FROM workflow_runs')).rows[0]?.state === 'RECONCILIATION_REQUIRED'; }, 'deadline reconciliation');
        assert.equal((await tool(db)).state, 'UNKNOWN'); assert.equal(await runOne(db, randomUUID()), false);
        assert.equal(await count(external, 'external_requests', 'POST'), 1); assert.equal(await count(external, 'external_writes'), 1);
      });
    }
    await runCase('deadline expiry preserves VERIFIED receipt while parking unfinished bookkeeping', 'keyed', 'normal', async ({ db, external, url }) => {
      await db.query("UPDATE step_runs SET lease_ms=600,max_elapsed_ms=1200 WHERE step_key='write-summary'");
      const worker = await actor(url); await worker.call('claim'); await worker.call('execute');
      const receipt = (await tool(db)).receipt; assert.ok(receipt);
      await waitFor(async () => (await db.query("SELECT 1 FROM step_runs WHERE step_key='write-summary' AND deadline_at<=clock_timestamp()")).rowCount === 1, 'real hard deadline');
      assert.equal(await recoverOne(db), true);
      assert.equal((await db.query('SELECT state FROM workflow_runs')).rows[0]?.state, 'RECONCILIATION_REQUIRED');
      assert.equal((await tool(db)).state, 'VERIFIED'); assert.deepEqual((await tool(db)).receipt, receipt);
      assert.equal(await worker.call('complete', receipt), false); assert.equal(await runOne(db, randomUUID()), false);
      assert.equal(await count(external, 'external_requests', 'POST'), 1);
    });

    await runCase('stale effect worker cannot save receipts or complete results', 'keyed', 'hold-response', async ({ db, external, url, restart }) => {
      await db.query("UPDATE step_runs SET lease_ms=600 WHERE step_key='write-summary'");
      const old = await actor(url); const oldClaim = await old.call('claim') as Claim;
      const pending = old.call('execute').catch(() => undefined);
      await waitFor(async () => await count(external, 'external_writes') === 1, 'stale actor external commit');
      assert.equal(old.owned.child.kill('SIGSTOP'), true);
      try {
        await restart('normal'); await retry(db);
        const fresh = await claimStep(db, randomUUID()); assert.ok(fresh); assert.ok(fresh.fence > oldClaim.fence);
        const receipt = (await external.query('SELECT receipt FROM external_writes')).rows[0]?.receipt;
        assert.equal(old.owned.child.kill('SIGCONT'), true); await pending;
        assert.equal(await old.call('save', receipt), false); assert.equal(await old.call('complete', receipt), false);
        assert.equal((await tool(db)).state, 'UNKNOWN');
        assert.equal(await completeStep(db, fresh, receipt), false, 'receipt must be verified before completion');
      } finally { if (!old.owned.exit) old.owned.child.kill('SIGCONT'); }
    });

    await runCase('reliable key permits same-key resend only after not-found verification', 'keyed', 'reject-before-write', async ({ db, external, restart }) => {
      const before = (await tool(db)).effect_key;
      await runOne(db, randomUUID()); assert.equal(await count(external, 'external_writes'), 0);
      await restart('normal'); await retry(db); await runOne(db, randomUUID());
      assert.equal((await tool(db)).effect_key, before); assert.equal((await tool(db)).state, 'VERIFIED');
      assert.deepEqual((await external.query('SELECT method FROM external_requests ORDER BY id')).rows.map(r => r.method), ['POST','GET','POST']);
      assert.equal(await count(external, 'external_writes'), 1);
    });

    await runCase('bounded failed reconciliation parks UNKNOWN rather than inventing failure', 'keyed', 'lookup-unavailable', async ({ db, external, restart }) => {
      await restart('hold-response'); await runOne(db, randomUUID()); await restart('lookup-unavailable');
      for (let i = 0; i < 2; i++) { await retry(db); await runOne(db, randomUUID()); }
      assert.equal((await tool(db)).state, 'UNKNOWN');
      assert.equal((await db.query('SELECT state FROM workflow_runs')).rows[0]?.state, 'RECONCILIATION_REQUIRED');
      assert.equal(await recoverOne(db), false); assert.equal(await count(external, 'external_requests', 'POST'), 1);
    });

    await runCase('v2 admission binds contract and intent atomically with stable replay', 'unkeyed', 'normal', async ({ db, run, external }) => {
      const request = { workflow: 'incident-triage', version: 2, input, toolContract: 'unkeyed' } as const;
      const replay = await createRun(db, 'local-operator', 'effect', request); assert.equal(replay.run.id, run); assert.equal(replay.created, false);
      await assert.rejects(createRun(db, 'local-operator', 'effect', { ...request, toolContract: 'keyed' }), IdempotencyConflict);
      await db.query(`CREATE FUNCTION reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected intent failure'; END $$;
        CREATE TRIGGER intent_failure BEFORE INSERT ON tool_invocations FOR EACH ROW EXECUTE FUNCTION reject_intent();`);
      await assert.rejects(createRun(db, 'local-operator', 'rollback', request));
      assert.equal((await db.query('SELECT * FROM workflow_runs')).rowCount, 1);
      assert.equal((await db.query('SELECT * FROM step_runs')).rowCount, 3);
      await runOne(db, randomUUID()); assert.equal((await tool(db)).state, 'VERIFIED');
      assert.equal(await count(external, 'external_writes'), 1);
    });

    await runCase('v2 HTTP admission converges to one durable invocation and exposes reconciliation state', 'keyed', 'normal', async ({ db, url, record }) => {
      const api = platform.child('api', process.execPath, ['dist/src/entrypoints/api.js'], {
        ...process.env, DATABASE_URL: url, OPERATOR_TOKEN: platform.token, PORT: '0',
      });
      const endpoint = await waitFor(() => {
        if (api.exit || api.failure) throw new Error('API did not start');
        const line = api.output.split('\n').find(line => line.startsWith('{'));
        return line ? (JSON.parse(line) as { url: string }).url : false;
      }, 'v2 API listening');
      const headers = { authorization: ['Bearer',platform.token].join(' '), 'content-type': 'application/json', 'idempotency-key': 'http-v2' };
      const body = { workflow: 'incident-triage', version: 2, input, toolContract: 'keyed' };
      const post = (value: unknown = body) => fetch(endpoint + '/runs', { method: 'POST', headers, body: JSON.stringify(value) });
      const blocker = await db.connect(); let pending: Promise<Response>[] = [];
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE');
        pending = Array.from({ length: 8 }, () => post());
        record['admissionBlockedSessions'] = await waitFor(async () => {
          const rows = (await db.query("SELECT pid,wait_event FROM pg_stat_activity WHERE application_name='daw-api' AND state='active' AND wait_event_type='Lock'")).rows;
          return rows.length === 8 ? rows : false;
        }, 'eight v2 HTTP admissions blocked');
      } finally { await blocker.query('COMMIT'); blocker.release(); }
      const responses = await Promise.all(pending);
      assert.deepEqual(responses.map(r => r.status).sort(), [200,200,200,200,200,200,200,202]);
      const bodies = await Promise.all(responses.map(async r => await r.json() as { run_id: string }));
      assert.equal(new Set(bodies.map(r => r.run_id)).size, 1);
      const id = bodies[0]?.run_id; assert.ok(id);
      assert.equal((await db.query('SELECT * FROM tool_invocations WHERE run_id=$1', [id])).rowCount, 1);
      assert.equal((await post({ ...body, toolContract: 'unkeyed' })).status, 409);
      assert.equal((await post({ ...body, toolContract: 'other' })).status, 400);
      const view = await fetch(endpoint + '/runs/' + id, { headers });
      const stored = await view.json() as { tools: { state: string }[]; steps: unknown[] };
      assert.equal(stored.tools[0]?.state, 'PREPARED'); assert.equal(stored.steps.length, 3);
    });
  } finally {
    const failures: unknown[] = [];
    for (const close of [() => platformAdmin?.end(), () => providerAdmin?.end(), () => platform.cleanup(), () => provider.cleanup()]) {
      try { await close(); } catch (e) { failures.push(e); }
    }
    record['cleanup'] = [...platform.children, ...provider.children].map(p => ({ role: p.role, pid: p.child.pid, exit: p.exit, failure: p.failure }));
    if (process.env['DAW_EVIDENCE_DIR']) await writeFile(path.join(process.env['DAW_EVIDENCE_DIR'], 'effects.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    if (failures.length) throw new AggregateError(failures, 'effects cleanup failed');
  }
});
