import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { Lab, waitFor } from './support/lab.js';
import { createPool } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrations.js';
import { createRun } from '../src/application/runs.js';
import { runOne } from '../src/application/worker.js';
import { claimStep, completeStep, recoverOne } from '../src/application/execution.js';
import { executeAgent, LostAgentOwnership, AgentInfrastructureError } from '../src/application/agent.js';
import { deterministicAdapter, ModelUnavailable, openAiAdapter } from '../src/agents/adapters.js';
import type { LlmAdapter } from '../src/agents/adapters.js';

const input = { title: ' representative agent incident ', severity: 'high' } as const;
const request = { workflow: 'incident-triage', version: 3, input } as const;
const read = JSON.stringify({ kind: 'read', tool: 'incident-context', arguments: { topic: 'summary' }, summary: null, evidence: [] });
test('DAW-4 real PostgreSQL bounded checkpoint execution', { timeout: 120000 }, async t => {
  assert.ok(!process.env['DAW_AGENT_ADAPTER'] || process.env['DAW_AGENT_ADAPTER'] === 'deterministic', 'integration tests forbid live model adapters');
  const lab = new Lab(); let admin: pg.Pool | undefined;
  const cases: Record<string, unknown> = {};
  const state = async (db: pg.Pool) => (await db.query('SELECT state FROM workflow_runs')).rows[0]?.state as string;
  const session = async (db: pg.Pool) => (await db.query('SELECT calls,tool_calls,reserved_cost_micros FROM agent_sessions')).rows[0];
  const runCase = async (name: string, body: (db: pg.Pool, url: string, run: string) => Promise<void>) => {
    const selected = process.env['DAW_AGENT_CASE'];
    if (selected && !process.env['DAW_AGENT_MUTATION']) throw new Error('agent selector requires mutation');
    if (selected && selected !== name) return;
    await t.test(name, async () => {
      assert.ok(admin); const database = 'agent_' + randomUUID().replaceAll('-', '');
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(lab.url); url.pathname = '/' + database;
      const db = createPool(url.href, 'daw-agent-observer'), start = lab.children.length;
      try {
        await migrate(db);
        const { run } = await createRun(db, 'local-operator', 'agent', request);
        await runOne(db, randomUUID()); await runOne(db, randomUUID());
        await body(db, url.href, run.id);
      } finally {
        const failures: unknown[] = [];
        for (const p of lab.children.slice(start).reverse()) {
          try { if (!p.exit) p.child.kill('SIGCONT'); await lab.stop(p); } catch (e) { failures.push(e); }
        }
        try { cases[name] = { state: await state(db), session: await session(db),
          decisions: (await db.query('SELECT turn,decision,observation FROM agent_decisions ORDER BY turn')).rows,
          calls: (await db.query('SELECT call_no,turn,fence,state,reserved_cost_micros FROM agent_calls ORDER BY call_no')).rows,
          events: (await db.query('SELECT sequence,type,details FROM run_events ORDER BY sequence')).rows };
        } catch (e) { failures.push(e); }
        try { await db.end(); } catch (e) { failures.push(e); }
        if (failures.length) throw new AggregateError(failures, 'agent case cleanup failed');
      }
    });
  };
  try {
    await lab.startPostgres(); admin = createPool(lab.url);
    await runCase('valid decisions checkpoint and complete through the engine', async (db, _url, run) => {
      const claim = await claimStep(db, randomUUID()); assert.ok(claim);
      assert.equal(await completeStep(db, claim, { summary: 'invented', evidence: [] }), false);
      const result = await executeAgent(db, claim, new AbortController().signal);
      assert.equal(await completeStep(db, claim, { summary: 'different', evidence: [] }), false);
      assert.equal(await completeStep(db, claim, result), true);
      assert.equal(await state(db), 'SUCCEEDED'); assert.deepEqual(await session(db), { calls: 2, tool_calls: 1, reserved_cost_micros: 20000 });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_decisions WHERE run_id=$1', [run])).rows[0]?.n, 2);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM tool_invocations')).rows[0]?.n, 0);
    });
    await runCase('v3 concurrent HTTP admission binds one session and rejects policy inputs', async (db, url) => {
      const apiLab = new Lab(); apiLab.url = url;
      try {
        const api = await apiLab.startApi();
        const send = (body: unknown, key: string) => fetch(api.url + '/runs', { method: 'POST',
          headers: { Authorization: `Bearer ${apiLab.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
        const responses = await Promise.all(Array.from({ length: 8 }, () => send(request, 'http-agent')));
        assert.deepEqual(responses.map(r => r.status).sort(), [200,200,200,200,200,200,200,202]);
        for (const r of responses) await r.json();
        for (const field of ['budget', 'adapter', 'maxTurns', 'approved', 'url']) {
          const response = await send({ ...request, [field]: 'override' }, 'invalid-policy'); assert.equal(response.status, 400); await response.json();
        }
        const conflict = await send({ ...request, input: { ...input, severity: 'low' } }, 'http-agent'); assert.equal(conflict.status, 409); await conflict.json();
        assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_sessions')).rows[0]?.n, 2);
      } finally { await apiLab.cleanup(); }
    });
    await runCase('malformed and unregistered model proposals cannot execute tools', async (db) => {
      let calls = 0;
      const adapter: LlmAdapter = { async decide() { calls++; return JSON.stringify({ kind: 'read', tool: 'shell', arguments: { topic: 'summary' }, summary: null, evidence: [] }); } };
      await runOne(db, randomUUID(), (claim, signal) => executeAgent(db, claim, signal, adapter));
      assert.equal(calls, 1); assert.equal(await state(db), 'FAILED'); assert.equal((await session(db))?.tool_calls, 0);
      assert.equal((await db.query('SELECT state FROM agent_calls')).rows[0]?.state, 'REJECTED');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_decisions')).rows[0]?.n, 0);
    });
    await runCase('turn budget prevents another model decision after the accepted limit', async db => {
      await db.query('UPDATE agent_sessions SET max_turns=1');
      await runOne(db, randomUUID());
      assert.equal(await state(db), 'FAILED'); assert.equal((await session(db))?.calls, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_decisions')).rows[0]?.n, 1);
    });
    await runCase('registered tool invalid arguments are rejected before any tool reservation', async db => {
      const adapter: LlmAdapter = { async decide() { return JSON.stringify({ kind: 'read', tool: 'incident-context', arguments: { topic: 'guidance' }, summary: null, evidence: [] }); } };
      await runOne(db, randomUUID(), (claim, signal) => executeAgent(db, claim, signal, adapter));
      assert.equal(await state(db), 'FAILED'); assert.equal((await session(db))?.tool_calls, 0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_decisions')).rows[0]?.n, 0);
      assert.equal((await db.query('SELECT state FROM agent_calls')).rows[0]?.state, 'REJECTED');
    });
    await runCase('malformed completed provider response is permanent not a transport retry', async db => {
      const adapter = openAiAdapter(randomBytes(32).toString('hex'), async () => Response.json(null));
      await runOne(db, randomUUID(), (claim, signal) => executeAgent(db, claim, signal, adapter));
      assert.equal(await state(db), 'FAILED'); assert.equal((await session(db))?.calls, 1);
      assert.equal((await db.query('SELECT state FROM agent_calls')).rows[0]?.state, 'REJECTED');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_decisions')).rows[0]?.n, 0);
    });
    await runCase('cost budget is reserved before dispatch and never refunded', async db => {
      await db.query('UPDATE agent_sessions SET max_cost_micros=10000');
      await runOne(db, randomUUID());
      assert.equal(await state(db), 'FAILED'); assert.deepEqual(await session(db), { calls: 1, tool_calls: 1, reserved_cost_micros: 10000 });
    });
    await runCase('call and tool execution budgets are independent bounds', async db => {
      await db.query('UPDATE agent_sessions SET max_tool_calls=1');
      await runOne(db, randomUUID(), (claim, signal) => executeAgent(db, claim, signal, { async decide() { return read; } }));
      assert.equal(await state(db), 'FAILED'); assert.deepEqual(await session(db), { calls: 2, tool_calls: 1, reserved_cost_micros: 20000 });
    });
    await runCase('model timeout keeps its reservation and retry cannot exceed call budget', async db => {
      await db.query('UPDATE agent_sessions SET max_calls=1,call_timeout_ms=40');
      const start = performance.now();
      await runOne(db, randomUUID(), (claim, signal) => executeAgent(db, claim, signal, { decide: () => new Promise(() => {}) }));
      assert.ok(performance.now() - start < 1500); assert.equal(await state(db), 'RUNNING');
      await waitFor(async () => { await recoverOne(db); return (await db.query("SELECT 1 FROM step_runs WHERE step_key='analyze-incident' AND state='READY'")).rowCount === 1; }, 'retry');
      await runOne(db, randomUUID());
      assert.equal(await state(db), 'FAILED'); assert.equal((await session(db))?.calls, 1); assert.equal((await session(db))?.reserved_cost_micros, 10000);
    });
    await runCase('database deadline blocks acceptance even when a model returns late', async db => {
      await db.query("UPDATE step_runs SET lease_ms=500,max_elapsed_ms=550 WHERE step_key='analyze-incident'");
      const claim = await claimStep(db, randomUUID()); assert.ok(claim);
      const started = performance.now();
      await assert.rejects(executeAgent(db, claim, new AbortController().signal, { decide: () => new Promise(() => {}) }), ModelUnavailable);
      assert.ok(performance.now() - started < 1800);
      await waitFor(async () => { await recoverOne(db); return await state(db) === 'FAILED'; }, 'deadline failure');
      assert.equal((await session(db))?.calls, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_decisions')).rows[0]?.n, 0);
    });
    await runCase('SIGKILL after accepted decision resumes without regenerating it', async (db, url) => {
      await db.query("UPDATE step_runs SET lease_ms=600 WHERE step_key='analyze-incident'");
      const blocker = await db.connect();
      try {
        await blocker.query('SELECT pg_advisory_lock(21404,1)');
        await db.query(`CREATE FUNCTION block_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.observation IS NOT NULL THEN PERFORM pg_advisory_xact_lock(21404,1); END IF; RETURN NEW; END $$;
          CREATE TRIGGER checkpoint_barrier BEFORE UPDATE ON agent_decisions FOR EACH ROW EXECUTE FUNCTION block_observation()`);
        const worker = lab.child('agent-worker', process.execPath, ['dist/src/entrypoints/worker.js'], { ...process.env, DATABASE_URL: url });
        await waitFor(async () => (await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'UPDATE agent_decisions SET observation%'")).rowCount === 1, 'accepted decision observation barrier');
        const before = (await db.query('SELECT decision FROM agent_decisions WHERE turn=1')).rows[0]?.decision;
        assert.ok(before); assert.equal((await session(db))?.calls, 1);
        await lab.stop(worker, 'SIGKILL'); await blocker.query('SELECT pg_advisory_unlock(21404,1)');
        await db.query('DROP TRIGGER checkpoint_barrier ON agent_decisions');
        const replacement = lab.child('agent-worker-restart', process.execPath, ['dist/src/entrypoints/worker.js'], { ...process.env, DATABASE_URL: url });
        await waitFor(async () => { await recoverOne(db); const s = await state(db); return s === 'SUCCEEDED' || s === 'FAILED'; }, 'agent terminal after restart', 15000);
        await lab.stop(replacement);
        assert.equal(await state(db), 'SUCCEEDED'); assert.equal((await session(db))?.calls, 2);
        assert.deepEqual((await db.query('SELECT decision FROM agent_decisions WHERE turn=1')).rows[0]?.decision, before);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_calls WHERE turn=1')).rows[0]?.n, 1);
      } finally {
        try { await blocker.query('SELECT pg_advisory_unlock_all()'); }
        finally { blocker.release(true); }
      }
    });
    await runCase('stale worker cannot accept a delayed decision after lease recovery', async db => {
      await db.query("UPDATE step_runs SET lease_ms=500 WHERE step_key='analyze-incident'");
      const claim = await claimStep(db, randomUUID()); assert.ok(claim);
      let release: ((raw: string) => void) | undefined;
      const pending = executeAgent(db, claim, new AbortController().signal, { decide: () => new Promise<string>(resolve => { release = resolve; }) });
      const rejected = assert.rejects(pending, LostAgentOwnership);
      await waitFor(() => release ? true : false, 'model reserved');
      await waitFor(async () => { await recoverOne(db); return (await db.query("SELECT 1 FROM step_runs WHERE step_key='analyze-incident' AND state='READY'")).rowCount === 1; }, 'expired agent ready');
      await runOne(db, randomUUID()); release?.(read); await rejected;
      assert.equal(await state(db), 'SUCCEEDED');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM agent_calls WHERE fence=$1 AND state='ACCEPTED'", [claim.fence])).rows[0]?.n, 0);
    });
    await runCase('accepted finish checkpoint is reused without any model invocation', async db => {
      const claim = await claimStep(db, randomUUID()); assert.ok(claim);
      const result = await executeAgent(db, claim, new AbortController().signal);
      let calls = 0;
      assert.deepEqual(await executeAgent(db, claim, new AbortController().signal, { async decide(c, signal) { calls++; return deterministicAdapter.decide(c, signal); } }), result);
      assert.equal(calls, 0); assert.equal(await completeStep(db, claim, result), true);
    });
    await runCase('decision and acceptance event roll back together on database failure', async db => {
      await db.query(`CREATE FUNCTION reject_agent_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='AGENT_DECISION_ACCEPTED' THEN RAISE EXCEPTION 'injected checkpoint failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_agent_event BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_agent_event()`);
      const claim = await claimStep(db, randomUUID()); assert.ok(claim);
      await assert.rejects(executeAgent(db, claim, new AbortController().signal), AgentInfrastructureError);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_decisions')).rows[0]?.n, 0);
      assert.equal((await db.query('SELECT state FROM agent_calls')).rows[0]?.state, 'RESERVED');
      assert.equal((await session(db))?.reserved_cost_micros, 10000);
      assert.equal(await state(db), 'RUNNING');
    });
    await runCase('saved tool observation survives retry without being read again', async db => {
      let calls = 0;
      await runOne(db, randomUUID(), (claim, signal) => executeAgent(db, claim, signal, { async decide(c, s) {
        calls++; if (calls === 2) throw new ModelUnavailable('synthetic lost response');
        return deterministicAdapter.decide(c, s);
      } }));
      assert.equal((await session(db))?.tool_calls, 1);
      await waitFor(async () => { await recoverOne(db); return (await db.query("SELECT 1 FROM step_runs WHERE step_key='analyze-incident' AND state='READY'")).rowCount === 1; }, 'agent retry ready');
      await runOne(db, randomUUID());
      assert.equal(await state(db), 'SUCCEEDED');
      assert.deepEqual(await session(db), { calls: 3, tool_calls: 1, reserved_cost_micros: 30000 });
    });
  } finally {
    const failures: unknown[] = [];
    try { await admin?.end(); } catch (e) { failures.push(e); }
    try { await lab.cleanup(); } catch (e) { failures.push(e); }
    if (process.env['DAW_EVIDENCE_DIR']) await writeFile(path.join(process.env['DAW_EVIDENCE_DIR'], 'agent.json'), JSON.stringify({
      node: process.version, pgBin: lab.pgBin, postgresDirectory: lab.directory, cases,
      processes: lab.children.map(p => ({ role: p.role, pid: p.child.pid, exit: p.exit ?? null })),
    }, null, 2) + '\n', { flag: 'wx' });
    if (failures.length) throw new AggregateError(failures, 'agent suite cleanup failed');
  }
});
