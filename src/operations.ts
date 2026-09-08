import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import type { Claim } from './application/execution.js';

export const operationalPolicy = Object.freeze({ maxInFlight: 32, shutdownMs: 5000, idlePollMs: 100, errorPollMs: 500 });
export function probePool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, application_name: 'daw-operations', max: 2,
    connectionTimeoutMillis: 1000, idleTimeoutMillis: 1000, statement_timeout: 500, query_timeout: 1500 });
  pool.on('error', () => console.error(JSON.stringify({ event: 'probe_pool_error' })));
  return pool;
}
let expected: Promise<Record<string,string>> | undefined;
function schemaIdentity(): Promise<Record<string,string>> {
  return expected ??= (async () => {
    const files = (await readdir('migrations')).filter(f => /^\d{3}_[a-z_]+\.sql$/.test(f)).sort();
    if (!files.length) throw new Error('missing schema identity');
    return Object.fromEntries(await Promise.all(files.map(async f => [f,createHash('sha256').update((await readFile('migrations/'+f,'utf8')).replace(/\r\n/g,'\n')).digest('hex')])));
  })();
}
/** Read-only schema identity probe, never migration or a promise of execution/provider health. */
export async function ready(pool: pg.Pool): Promise<boolean> {
  const identity = await schemaIdentity();
  await pool.query('SELECT r.cancel_requested_at,s.fence,a.expires_at,i.receipt,g.model FROM workflow_runs r CROSS JOIN step_runs s CROSS JOIN approvals a CROSS JOIN tool_invocations i CROSS JOIN agent_sessions g LIMIT 0');
  const result = await pool.query(`SELECT COALESCE(jsonb_object_agg(name,sha256),'{}'::jsonb)=$1::jsonb AS ready FROM schema_migrations`,[identity]);
  return result.rows[0]?.ready === true;
}
/** Finite schema: no run IDs, owners, effect keys, input or free-form labels. Counts describe retained rows. */
export async function operationalSnapshot(pool: pg.Pool) {
  const result = await pool.query(`SELECT
    (SELECT count(*)::int FROM step_runs WHERE state='READY') AS ready_steps,
    (SELECT GREATEST(COALESCE(EXTRACT(epoch FROM clock_timestamp()-min(available_at)),0),0)::float8 FROM step_runs WHERE state='READY') AS oldest_ready_seconds,
    (SELECT count(*)::int FROM step_runs WHERE state='RUNNING' AND lease_expires_at>clock_timestamp()) AS live_leases,
    (SELECT count(*)::int FROM step_runs WHERE state='RUNNING' AND lease_expires_at<=clock_timestamp()) AS expired_leases,
    (SELECT count(*)::int FROM step_runs WHERE state='RETRY_WAIT') AS retry_wait_steps,
    (SELECT count(*)::int FROM step_runs WHERE state='RETRY_WAIT' AND available_at<=clock_timestamp()) AS due_retries,
    (SELECT count(*)::int FROM step_attempts WHERE outcome='EXPIRED') AS recovered_attempts,
    (SELECT count(*)::int FROM step_attempts WHERE outcome='RETRYABLE') AS retryable_attempts,
    (SELECT count(*)::int FROM workflow_runs WHERE state='WAITING_APPROVAL') AS waiting_approval_runs,
    (SELECT count(*)::int FROM workflow_runs WHERE state='CANCELLED') AS cancelled_runs,
    (SELECT count(*)::int FROM workflow_runs WHERE state='RECONCILIATION_REQUIRED') AS reconciliation_runs,
    (SELECT count(*)::int FROM tool_invocations WHERE state='UNKNOWN') AS unknown_effects,
    (SELECT count(*)::int FROM workflow_runs WHERE state='FAILED') AS failed_runs,
    (SELECT count(*)::int FROM workflow_runs WHERE state='SUCCEEDED') AS succeeded_runs`);
  return { schema_version: 1, ...result.rows[0] };
}
export function attemptSpan(claim: Claim) {
  const started = performance.now(), span = randomBytes(8).toString('hex');
  const base = { event: 'attempt_span', trace_id: claim.run_id.replaceAll('-',''), span_id: span,
    run_id: claim.run_id, step: claim.step_key, attempt: claim.attempt_count, fence: claim.fence };
  console.log(JSON.stringify({ ...base, phase: 'start' }));
  return (outcome: 'accepted' | 'retired' | 'ownership_lost' | 'deferred' | 'infrastructure_error') =>
    console.log(JSON.stringify({ ...base, phase: 'end', outcome, duration_ms: Math.max(0,performance.now()-started) }));
}
/** An outer deadline bounds cooperative drain; process death leaves DB leases/UNKNOWN for recovery. */
export function shutdownControl(role: 'api' | 'worker' | 'scheduler') {
  const controller = new AbortController(); let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    console.log(JSON.stringify({ event: 'draining', role }));
    timer = setTimeout(() => { console.error(JSON.stringify({ event: 'shutdown_deadline', role })); process.exit(1); }, operationalPolicy.shutdownMs);
    controller.abort();
  };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  return { signal: controller.signal, finish() {
    if (timer) clearTimeout(timer);
    process.removeListener('SIGTERM',stop); process.removeListener('SIGINT',stop);
    console.log(JSON.stringify({ event: 'stopped', role }));
  } };
}
