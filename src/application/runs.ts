import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { definition, definitionHash, effectDefinition, effectDefinitionHash, fingerprint, normalizeIncident, summarizeIncident } from '../domain/workflow.js';
import { effectKey, effectFingerprint, effectTarget } from '../domain/effect.js';
import type { CreateRunRequest, IncidentInput } from '../domain/workflow.js';
import { agentDefinition, agentDefinitionHash } from '../domain/workflow.js';
import { agentPolicy, modelSnapshot } from '../domain/agent.js';

export class IdempotencyConflict extends Error {}
export interface RunRow {
  id: string; workflow_name: string; workflow_version: number; definition_hash: string;
  input: IncidentInput; state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED'; created_at: Date; request_fingerprint: string;
}
const columns = 'id, workflow_name, workflow_version, definition_hash, input, state, created_at, request_fingerprint';

/** Commits the run, all initial step states and creation event together. No work is executed. */
export async function createRun(pool: pg.Pool, caller: string, key: string, request: CreateRunRequest): Promise<{ run: RunRow; created: boolean }> {
  const client = await pool.connect();
  try {
    // A second statement sees a concurrently committed winner after ON CONFLICT waits.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const hash = fingerprint(request);
    const selected = request.version === 3 ? agentDefinition : request.version === 2 ? effectDefinition : definition;
    const selectedHash = request.version === 3 ? agentDefinitionHash : request.version === 2 ? effectDefinitionHash : definitionHash;
    const inserted = await client.query<RunRow>(`INSERT INTO workflow_runs
      (id, caller_id, idempotency_key, request_fingerprint, workflow_name, workflow_version, definition_hash, definition, input, state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED')
      ON CONFLICT (caller_id, idempotency_key) DO NOTHING RETURNING ${columns}`,
    [randomUUID(), caller, key, hash, selected.name, selected.version, selectedHash, selected, request.input]);
    let run = inserted.rows[0];
    const created = run !== undefined;
    if (run !== undefined) {
      for (const step of selected.steps) {
        await client.query(`INSERT INTO step_runs(run_id,step_key,ordinal,state,available_at)
          VALUES ($1,$2,$3,$4,CASE WHEN $4 = 'READY' THEN clock_timestamp() ELSE NULL END)`,
        [run.id, step.key, step.ordinal, step.state]);
      }
      if (request.version === 2) {
        const target = effectTarget();
        const payload = { summary: summarizeIncident(normalizeIncident(request.input)) };
        await client.query(`INSERT INTO tool_invocations(run_id,step_key,effect_key,contract,service_id,service_url,request,request_fingerprint)
          VALUES ($1,'write-summary',$2,$3,$4,$5,$6,$7)`,
        [run.id, effectKey(run.id), request.toolContract, target.id, target.url, payload, effectFingerprint(payload)]);
      }
      if (request.version === 3) {
        const adapter = process.env['DAW_AGENT_ADAPTER'] ?? 'deterministic';
        if (adapter !== 'deterministic' && adapter !== 'openai') throw new Error('unsupported agent adapter');
        await client.query(`INSERT INTO agent_sessions(run_id,step_key,adapter,model,max_turns,max_calls,max_tool_calls,max_cost_micros,call_cost_micros,call_timeout_ms)
          VALUES($1,'analyze-incident',$2,$3,$4,$5,$6,$7,$8,$9)`, [run.id,adapter,modelSnapshot,agentPolicy.maxTurns,agentPolicy.maxCalls,agentPolicy.maxToolCalls,agentPolicy.maxCostMicros,agentPolicy.callCostMicros,agentPolicy.callTimeoutMs]);
        await client.query("UPDATE step_runs SET max_elapsed_ms=$2 WHERE run_id=$1 AND step_key='analyze-incident'", [run.id,agentPolicy.maxElapsedMs]);
      }
      await client.query("INSERT INTO run_events(run_id,sequence,type) VALUES ($1,1,'RUN_CREATED')", [run.id]);
    } else {
      const existing = await client.query<RunRow>(`SELECT ${columns} FROM workflow_runs WHERE caller_id=$1 AND idempotency_key=$2`, [caller, key]);
      run = existing.rows[0];
      if (!run) throw new Error('committed idempotency winner missing');
      if (run.request_fingerprint !== hash) throw new IdempotencyConflict();
    }
    await client.query('COMMIT');
    return { run, created };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function getRun(pool: pg.Pool, caller: string, id: string): Promise<unknown | null> {
  // One statement gives run and steps one consistent snapshot.
  const result = await pool.query(`SELECT r.id, r.workflow_name AS workflow, r.workflow_version AS version,
    r.definition_hash, r.input, r.state, r.created_at,
    (SELECT jsonb_agg(jsonb_build_object('key',s.step_key,'state',s.state,'available_at',s.available_at,
      'attempt_count',s.attempt_count,'fence',s.fence,'lease_expires_at',s.lease_expires_at,
      'deadline_at',s.deadline_at,'result',s.result,'last_error',s.last_error)
      ORDER BY s.ordinal) FROM step_runs s WHERE s.run_id=r.id) AS steps,
    (SELECT jsonb_agg(jsonb_build_object('step',i.step_key,'effect_key',i.effect_key,'contract',i.contract,
      'state',i.state,'sends',i.sends,'verifications',i.verifications,'receipt',i.receipt))
      FROM tool_invocations i WHERE i.run_id=r.id) AS tools,
    (SELECT jsonb_build_object('adapter',a.adapter,'calls',a.calls,'tool_calls',a.tool_calls,'reserved_cost_micros',a.reserved_cost_micros,
      'max_turns',a.max_turns,'max_calls',a.max_calls,'max_cost_micros',a.max_cost_micros,
      'checkpoints',(SELECT jsonb_agg(jsonb_build_object('turn',d.turn,'decision',d.decision,'observation',d.observation) ORDER BY d.turn)
        FROM agent_decisions d WHERE d.run_id=a.run_id AND d.step_key=a.step_key)) FROM agent_sessions a WHERE a.run_id=r.id) AS agent
    FROM workflow_runs r WHERE r.id=$1 AND r.caller_id=$2`, [id, caller]);
  return result.rows[0] as unknown ?? null;
}
