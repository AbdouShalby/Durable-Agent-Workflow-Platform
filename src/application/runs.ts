import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { definition, definitionHash, fingerprint } from '../domain/workflow.js';
import type { CreateRunRequest, IncidentInput } from '../domain/workflow.js';

export class IdempotencyConflict extends Error {}
export interface RunRow {
  id: string; workflow_name: string; workflow_version: number; definition_hash: string;
  input: IncidentInput; state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; created_at: Date; request_fingerprint: string;
}
const columns = 'id, workflow_name, workflow_version, definition_hash, input, state, created_at, request_fingerprint';

/** Commits the run, all initial step states and creation event together. No work is executed. */
export async function createRun(pool: pg.Pool, caller: string, key: string, request: CreateRunRequest): Promise<{ run: RunRow; created: boolean }> {
  const client = await pool.connect();
  try {
    // A second statement sees a concurrently committed winner after ON CONFLICT waits.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const hash = fingerprint(request);
    const inserted = await client.query<RunRow>(`INSERT INTO workflow_runs
      (id, caller_id, idempotency_key, request_fingerprint, workflow_name, workflow_version, definition_hash, definition, input, state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED')
      ON CONFLICT (caller_id, idempotency_key) DO NOTHING RETURNING ${columns}`,
    [randomUUID(), caller, key, hash, definition.name, definition.version, definitionHash, definition, request.input]);
    let run = inserted.rows[0];
    const created = run !== undefined;
    if (run !== undefined) {
      for (const step of definition.steps) {
        await client.query(`INSERT INTO step_runs(run_id,step_key,ordinal,state,available_at)
          VALUES ($1,$2,$3,$4,CASE WHEN $4 = 'READY' THEN clock_timestamp() ELSE NULL END)`,
        [run.id, step.key, step.ordinal, step.state]);
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
      ORDER BY s.ordinal) FROM step_runs s WHERE s.run_id=r.id) AS steps
    FROM workflow_runs r WHERE r.id=$1 AND r.caller_id=$2`, [id, caller]);
  return result.rows[0] as unknown ?? null;
}
