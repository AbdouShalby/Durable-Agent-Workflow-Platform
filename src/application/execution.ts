import type pg from 'pg';
import { retryDelay } from '../domain/retry.js';
import type { IncidentInput } from '../domain/workflow.js';

export interface Claim {
  run_id: string; step_key: string; ordinal: number; owner: string; fence: number;
  attempt_count: number; lease_ms: number; lease_expires_at: Date; deadline_at: Date;
  input: IncidentInput; workflow_name: string; workflow_version: number; definition_hash: string;
  previous_result: unknown;
}
interface Step extends Claim {
  state: string; max_attempts: number; retry_base_ms: number; retry_cap_ms: number;
}

export async function transaction<T>(pool: pg.Pool, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
// Every transition locks the run before the step. This also serializes event numbering.
export async function event(client: pg.PoolClient, run: string, type: string, details: unknown): Promise<void> {
  await client.query(`INSERT INTO run_events(run_id,sequence,type,details)
    SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3 FROM run_events WHERE run_id=$1`, [run, type, details]);
}
export async function lockStep(client: pg.PoolClient, run: string, step: string): Promise<Step | undefined> {
  await client.query('SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE', [run]);
  return (await client.query<Step>('SELECT * FROM step_runs WHERE run_id=$1 AND step_key=$2 FOR UPDATE', [run, step])).rows[0];
}
export async function owns(client: pg.PoolClient, claim: Claim): Promise<boolean> {
  // Evaluated AFTER lock acquisition. DB time, not the worker clock or transaction start time.
  return (await client.query(`SELECT 1 FROM step_runs WHERE run_id=$1 AND step_key=$2 AND state='RUNNING'
    AND owner=$3 AND fence=$4 AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`,
  [claim.run_id, claim.step_key, claim.owner, claim.fence])).rowCount === 1;
}

/** Claims at most one ready step without waiting on other workers' locked runs. Null means no eligible work now. */
export async function claimStep(pool: pg.Pool, owner: string): Promise<Claim | null> {
  return transaction(pool, async client => {
    const run = (await client.query<{ id: string; input: IncidentInput; workflow_name: string; workflow_version: number; definition_hash: string }>(`
      SELECT r.id,r.input,r.workflow_name,r.workflow_version,r.definition_hash FROM workflow_runs r
      WHERE r.state IN ('QUEUED','RUNNING') AND EXISTS (
        SELECT 1 FROM step_runs s WHERE s.run_id=r.id AND s.state='READY' AND s.available_at<=clock_timestamp()
        AND s.attempt_count<s.max_attempts AND (s.deadline_at IS NULL OR s.deadline_at>clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM step_runs p WHERE p.run_id=r.id AND p.ordinal<s.ordinal AND p.state<>'SUCCEEDED')
        AND NOT EXISTS (SELECT 1 FROM step_runs active WHERE active.run_id=r.id AND active.state='RUNNING'))
      ORDER BY r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
    if (!run) return null;
    const step = (await client.query<Step>(`SELECT * FROM step_runs WHERE run_id=$1 AND state='READY'
      AND available_at<=clock_timestamp() ORDER BY ordinal FOR UPDATE LIMIT 1`, [run.id])).rows[0];
    if (!step) return null;
    const claimed = (await client.query<Step>(`UPDATE step_runs SET state='RUNNING',available_at=NULL,
      owner=$3,attempt_count=attempt_count+1,fence=fence+1,
      deadline_at=COALESCE(deadline_at,clock_timestamp()+max_elapsed_ms*interval '1 millisecond'),
      lease_expires_at=LEAST(clock_timestamp()+lease_ms*interval '1 millisecond',
        COALESCE(deadline_at,clock_timestamp()+max_elapsed_ms*interval '1 millisecond'))
      WHERE run_id=$1 AND step_key=$2 AND state='READY' AND attempt_count<max_attempts
      AND (deadline_at IS NULL OR deadline_at>clock_timestamp()) RETURNING *`, [run.id, step.step_key, owner])).rows[0];
    if (!claimed) return null;
    await client.query(`INSERT INTO step_attempts(run_id,step_key,attempt,fence,owner,outcome) VALUES ($1,$2,$3,$4,$5,'RUNNING')`,
      [run.id, step.step_key, claimed.attempt_count, claimed.fence, owner]);
    await client.query("UPDATE workflow_runs SET state='RUNNING' WHERE id=$1", [run.id]);
    await event(client, run.id, 'STEP_CLAIMED', { step: step.step_key, attempt: claimed.attempt_count, fence: claimed.fence });
    const previous = (await client.query<{ result: unknown }>('SELECT result FROM step_runs WHERE run_id=$1 AND ordinal=$2 AND state=\'SUCCEEDED\'', [run.id, step.ordinal - 1])).rows[0];
    return { ...claimed, ...run, previous_result: previous?.result ?? null };
  });
}

/** A heartbeat cannot resurrect an expired lease or extend the persisted per-step deadline. */
export async function renewLease(pool: pg.Pool, claim: Claim): Promise<boolean> {
  return transaction(pool, async client => {
    await lockStep(client, claim.run_id, claim.step_key);
    if (!await owns(client, claim)) return false;
    await client.query(`UPDATE step_runs SET lease_expires_at=LEAST(deadline_at,clock_timestamp()+lease_ms*interval '1 millisecond')
      WHERE run_id=$1 AND step_key=$2`, [claim.run_id, claim.step_key]);
    return true;
  });
}

/** The ownership check under locks is the transition's linearization point; result, next step and event commit together. */
export async function completeStep(pool: pg.Pool, claim: Claim, result: unknown): Promise<boolean> {
  if (result === undefined || result === null) throw new Error('step result required');
  return transaction(pool, async client => {
    const step = await lockStep(client, claim.run_id, claim.step_key);
    if (!step || !await owns(client, claim)) return false;
    const tool = (await client.query('SELECT state,receipt=$3::jsonb AS matches FROM tool_invocations WHERE run_id=$1 AND step_key=$2', [claim.run_id, claim.step_key, JSON.stringify(result)])).rows[0];
    if (tool && (tool.state !== 'VERIFIED' || !tool.matches)) return false;
    const agent = (await client.query('SELECT 1 FROM agent_sessions WHERE run_id=$1 AND step_key=$2', [claim.run_id,claim.step_key])).rowCount;
    if (agent && !(await client.query(`SELECT 1 FROM agent_decisions WHERE run_id=$1 AND step_key=$2
      AND decision->>'kind'='finish' AND jsonb_build_object('summary',decision->'summary','evidence',decision->'evidence')=$3::jsonb`, [claim.run_id,claim.step_key,JSON.stringify(result)])).rowCount) return false;
    await client.query(`UPDATE step_runs SET state='SUCCEEDED',result=$3,owner=NULL,lease_expires_at=NULL,last_error=NULL
      WHERE run_id=$1 AND step_key=$2`, [claim.run_id, claim.step_key, JSON.stringify(result)]);
    await client.query(`UPDATE step_attempts SET outcome='SUCCEEDED',ended_at=clock_timestamp()
      WHERE run_id=$1 AND step_key=$2 AND attempt=$3`, [claim.run_id, claim.step_key, claim.attempt_count]);
    await event(client, claim.run_id, 'STEP_SUCCEEDED', { step: claim.step_key, fence: claim.fence });
    const next = await client.query(`UPDATE step_runs SET state='READY',available_at=clock_timestamp()
      WHERE run_id=$1 AND ordinal=$2 AND state='BLOCKED' RETURNING step_key`, [claim.run_id, step.ordinal + 1]);
    if (next.rowCount === 0) {
      await client.query("UPDATE workflow_runs SET state='SUCCEEDED' WHERE id=$1", [claim.run_id]);
      await event(client, claim.run_id, 'RUN_SUCCEEDED', {});
    }
    return true;
  });
}

async function retire(client: pg.PoolClient, step: Step, outcome: 'RETRYABLE' | 'PERMANENT' | 'EXPIRED'): Promise<void> {
  const delay = retryDelay(step.run_id, step.step_key, step.attempt_count, step.retry_base_ms, step.retry_cap_ms);
  const canRetry = outcome !== 'PERMANENT' && step.attempt_count < step.max_attempts &&
    (await client.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()+$2*interval \'1 millisecond\'', [step.deadline_at, delay])).rowCount === 1;
  const tool = (await client.query('SELECT state,contract FROM tool_invocations WHERE run_id=$1 AND step_key=$2', [step.run_id, step.step_key])).rows[0];
  if (tool && tool.state !== 'PREPARED' && (!canRetry || (tool.state === 'UNKNOWN' && tool.contract === 'unkeyed'))) {
    await client.query(`UPDATE step_attempts SET outcome=$4,ended_at=clock_timestamp(),error_code='EFFECT_UNKNOWN'
      WHERE run_id=$1 AND step_key=$2 AND attempt=$3`, [step.run_id,step.step_key,step.attempt_count,outcome]);
    await parkEffect(client, step.run_id, step.step_key);
    return;
  }
  await client.query(`UPDATE step_attempts SET outcome=$4,ended_at=clock_timestamp(),error_code=$4,retry_delay_ms=$5
    WHERE run_id=$1 AND step_key=$2 AND attempt=$3`, [step.run_id, step.step_key, step.attempt_count, outcome, canRetry ? delay : null]);
  await client.query(`UPDATE step_runs SET state=$3,owner=NULL,lease_expires_at=NULL,last_error=$4,
    available_at=CASE WHEN $3='RETRY_WAIT' THEN clock_timestamp()+$5*interval '1 millisecond' ELSE NULL END
    WHERE run_id=$1 AND step_key=$2`, [step.run_id, step.step_key, canRetry ? 'RETRY_WAIT' : 'FAILED', outcome, delay]);
  if (!canRetry) await client.query("UPDATE workflow_runs SET state='FAILED' WHERE id=$1", [step.run_id]);
  await event(client, step.run_id, canRetry ? 'RETRY_SCHEDULED' : 'RUN_FAILED', { step: step.step_key, attempt: step.attempt_count, outcome, delay_ms: canRetry ? delay : null });
}

async function parkEffect(client: pg.PoolClient, run: string, step: string): Promise<void> {
  await client.query(`UPDATE step_runs SET state='UNKNOWN',owner=NULL,lease_expires_at=NULL,available_at=NULL,last_error='RECONCILIATION_REQUIRED'
    WHERE run_id=$1 AND step_key=$2`, [run,step]);
  await client.query("UPDATE workflow_runs SET state='RECONCILIATION_REQUIRED' WHERE id=$1", [run]);
  await event(client, run, 'RECONCILIATION_REQUIRED', { step });
}

/** Explicit execution failures only. Database/unknown-commit errors must be left to lease recovery, not replayed here. */
export async function failStep(pool: pg.Pool, claim: Claim, retryable: boolean): Promise<boolean> {
  return transaction(pool, async client => {
    const step = await lockStep(client, claim.run_id, claim.step_key);
    if (!step || !await owns(client, claim)) return false;
    await retire(client, step, retryable ? 'RETRYABLE' : 'PERMANENT');
    return true;
  });
}

/** One bounded reconciliation transaction. Safe to call concurrently; false means nothing due now. */
export async function recoverOne(pool: pg.Pool): Promise<boolean> {
  return transaction(pool, async client => {
    const run = (await client.query<{ id: string }>(`SELECT r.id FROM workflow_runs r WHERE r.state IN ('QUEUED','RUNNING')
      AND EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id=r.id AND
        ((s.state='RUNNING' AND s.lease_expires_at<=clock_timestamp()) OR
         (s.state='RETRY_WAIT' AND s.available_at<=clock_timestamp()) OR
         (s.state IN ('READY','RETRY_WAIT') AND s.deadline_at<=clock_timestamp())))
      ORDER BY r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
    if (!run) return false;
    const step = (await client.query<Step>(`SELECT * FROM step_runs WHERE run_id=$1 AND
      ((state='RUNNING' AND lease_expires_at<=clock_timestamp()) OR
       (state='RETRY_WAIT' AND available_at<=clock_timestamp()) OR
       (state IN ('READY','RETRY_WAIT') AND deadline_at<=clock_timestamp()))
      ORDER BY ordinal FOR UPDATE LIMIT 1`, [run.id])).rows[0];
    if (!step) return false;
    if (step.state === 'RUNNING') await retire(client, step, 'EXPIRED');
    else {
      const expired = (await client.query('SELECT 1 WHERE $1::timestamptz<=clock_timestamp()', [step.deadline_at])).rowCount === 1;
      if (expired && (await client.query("SELECT 1 FROM tool_invocations WHERE run_id=$1 AND step_key=$2 AND state<>'PREPARED'", [run.id,step.step_key])).rowCount) {
        await parkEffect(client, run.id, step.step_key); return true;
      }
      await client.query(`UPDATE step_runs SET state=$3,available_at=CASE WHEN $3='READY' THEN clock_timestamp() ELSE NULL END
        WHERE run_id=$1 AND step_key=$2`, [run.id, step.step_key, expired ? 'FAILED' : 'READY']);
      if (expired) await client.query("UPDATE workflow_runs SET state='FAILED' WHERE id=$1", [run.id]);
      await event(client, run.id, expired ? 'RUN_FAILED' : 'RETRY_READY', { step: step.step_key, reason: expired ? 'DEADLINE' : 'RETRY_DUE' });
    }
    return true;
  });
}
