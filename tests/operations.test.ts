import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { Lab, waitFor } from './support/lab.js';
import { createPool } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrations.js';
import { createRun } from '../src/application/runs.js';
import { claimStep, completeStep, failStep, recoverOne } from '../src/application/execution.js';
import type { Claim } from '../src/application/execution.js';
import { operationalSnapshot, probePool } from '../src/operations.js';

const input = { workflow:'incident-triage',version:1,input:{title:'Synthetic operational canary',severity:'high'} } as const;
test('DAW-6 real PostgreSQL operational failure boundaries',{timeout:240000},async t => {
  assert.ok(!process.env['DAW_AGENT_ADAPTER'] || process.env['DAW_AGENT_ADAPTER']==='deterministic');
  const lab=new Lab(); let db:pg.Pool|undefined;
  const records: Record<string,unknown>={};
  const runCase=async(name:string, body:(pool:pg.Pool, api:Awaited<ReturnType<Lab['startApi']>>, record:Record<string,unknown>)=>Promise<void>)=>{
    const selected=process.env['DAW_OPERATIONS_CASE'];
    if(selected && !process.env['DAW_OPERATIONS_MUTATION']) throw new Error('selector requires mutation');
    if(selected && selected!==name) return;
    await t.test(name,async()=>{
      const start=lab.children.length, record:Record<string,unknown>={}; records[name]=record;
      const admin=createPool(lab.url), database='ops_'+randomUUID().replaceAll('-','');
      await admin.query(`CREATE DATABASE ${database}`); await admin.end();
      const original=lab.url, url=new URL(lab.url); url.pathname='/'+database; lab.url=url.href;
      db=createPool(lab.url,'daw-operational-observer');
      try { await migrate(db); const api=await lab.startApi(); await body(db,api,record); }
      finally {
        for(const p of lab.children.slice(start).reverse()) {
          if(p===lab.postgres) continue;
          if(!p.exit) { p.child.kill('SIGCONT'); await lab.stop(p,p.role.startsWith('postgres')?'SIGINT':'SIGTERM'); }
          record['processes']=lab.children.slice(start).filter(p=>!p.role.startsWith('postgres')).map(p=>({role:p.role,pid:p.child.pid,exit:p.exit??null,logs:p.output}));
        }
        await db.end(); db=undefined; lab.url=original;
      }
    });
  };
  const daemon=async(role:'worker'|'scheduler')=>{
    const p=lab.child(role,process.execPath,[`dist/src/entrypoints/${role}.js`],{...process.env,DATABASE_URL:lab.url});
    await waitFor(()=>p.output.includes('"event":"started"'),'daemon started',10000); return p;
  };
  const get=(url:string,route:string)=>fetch(url+route,{headers:{authorization:`Bearer ${lab.token}`},signal:AbortSignal.timeout(4000)});
  const post=(url:string,key:string)=>fetch(url+'/runs',{method:'POST',headers:{authorization:`Bearer ${lab.token}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
  const state=async(pool:pg.Pool,id:string)=>(await pool.query('SELECT state FROM workflow_runs WHERE id=$1',[id])).rows[0]?.state;
  const barrier=async(pool:pg.Pool)=>{
    const c=await pool.connect(); c.on('error',()=>{});
    await c.query('SELECT pg_advisory_lock(761602)');
    await pool.query("CREATE FUNCTION block_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='SUCCEEDED' THEN PERFORM pg_advisory_xact_lock(761602); END IF; RETURN NEW; END $$; CREATE TRIGGER block_completion BEFORE UPDATE ON step_runs FOR EACH ROW EXECUTE FUNCTION block_completion()");
    return c;
  };
  const blocked=async(pool:pg.Pool)=>waitFor(async()=> (await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='daw-worker' AND wait_event_type='Lock'")).rows[0]??false,'worker at completion barrier',12000);
  try {
    await lab.startPostgres();
    await runCase('readiness rejects unavailable database and mismatched schema while liveness stays alive',async(pool,api,record)=>{
      assert.equal((await get(api.url,'/readyz')).status,200);
      const identity=(await pool.query('SELECT sha256 FROM schema_migrations WHERE name=$1',['005_approvals.sql'])).rows[0]?.sha256;
      await pool.query("UPDATE schema_migrations SET sha256=$1 WHERE name='005_approvals.sql'",['0'.repeat(64)]);
      assert.equal((await get(api.url,'/readyz')).status,503); assert.equal((await get(api.url,'/healthz')).status,200);
      await pool.query("UPDATE schema_migrations SET sha256=$1 WHERE name='005_approvals.sql'",[identity]);
      await pool.query('ALTER TABLE workflow_runs RENAME TO temporarily_unavailable_runs');
      assert.equal((await get(api.url,'/readyz')).status,503);
      await pool.query('ALTER TABLE temporarily_unavailable_runs RENAME TO workflow_runs');
      assert.equal((await get(api.url,'/readyz')).status,200); record['schemaMismatchRejected']=true;
    });
    await runCase('PostgreSQL outage rejects admission and recovers a real workers lost lease',async(pool,api,record)=>{
      const c=await barrier(pool); let released=false;
      try {
        const worker=await daemon('worker'), scheduler=await daemon('scheduler');
        const {run}=await createRun(pool,'local-operator','outage',input); await blocked(pool);
        const stale=(await pool.query("SELECT s.*,r.workflow_name,r.workflow_version,r.definition_hash,r.input,NULL AS previous_result FROM step_runs s JOIN workflow_runs r ON r.id=s.run_id WHERE s.state='RUNNING'")).rows[0] as Claim;
        assert.ok(lab.postgres); await lab.stop(lab.postgres,'SIGINT');
        assert.equal((await get(api.url,'/healthz')).status,200); assert.equal((await get(api.url,'/readyz')).status,503);
        assert.equal((await post(api.url,'during-outage')).status,503);
        assert.equal(worker.exit,undefined,worker.output); assert.equal(scheduler.exit,undefined,scheduler.output);
        c.release(true); released=true; await lab.restartPostgres();
        await waitFor(async()=>await state(pool,run.id)==='SUCCEEDED','run recovered after database restart',20000);
        assert.equal((await get(api.url,'/readyz')).status,200);
        assert.equal(await completeStep(pool,stale,{}),false);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM workflow_runs WHERE idempotency_key='during-outage'")).rows[0]?.n,0);
        record['snapshot']=await operationalSnapshot(pool); assert.ok((record['snapshot'] as {recovered_attempts:number}).recovered_attempts>=1);
        record['sameWorkerRecovered']=worker.child.pid; record['staleRejected']=true;
        const spans=worker.output.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l) as Record<string,unknown>).filter(l=>l['event']==='attempt_span');
        assert.ok(spans.some(s=>s['outcome']==='accepted')); assert.ok(spans.every(s=>s['trace_id']===run.id.replaceAll('-','')));
        assert.ok(!worker.output.includes(input.input.title)); record['attemptSpans']=spans;
        await lab.stop(worker); await lab.stop(scheduler);
      } finally { if(!released) { try{await c.query('SELECT pg_advisory_unlock_all()');}catch{} c.release(true); } if(lab.postgres?.exit) await lab.restartPostgres(); }
    });
    await runCase('API SIGTERM drains a committed response and restart preserves replay identity',async(pool,api,record)=>{
      const c=await pool.connect(); let pending:Promise<Response>|undefined;
      try {
        await c.query('BEGIN'); await c.query('LOCK TABLE workflow_runs IN SHARE MODE');
        pending=post(api.url,'drain');
        await waitFor(async()=> (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='daw-api' AND wait_event_type='Lock'")).rowCount!==0,'API blocked insert');
        api.process.child.kill('SIGTERM'); await waitFor(()=>api.process.output.includes('"event":"draining"'),'API draining');
        assert.equal(api.process.exit,undefined); await c.query('COMMIT');
        const response=await pending; assert.equal(response.status,202); const first=await response.json() as {run_id:string};
        const exit=await waitFor(()=>api.process.exit??false,'API clean exit',7000); assert.equal(exit.code,0);
        const replacement=await lab.startApi(); const replay=await post(replacement.url,'drain'); assert.equal(replay.status,200);
        assert.equal((await replay.json() as {run_id:string}).run_id,first.run_id); record['run']=first.run_id;
      } finally { try{await c.query('ROLLBACK');}finally{c.release(true); if(pending) await Promise.allSettled([pending]);} }
    });
    await runCase('API shutdown deadline bounds blocked work without inventing admission',async(pool,api,record)=>{
      const c=await pool.connect(); let pending:Promise<unknown>|undefined;
      try {
        await c.query('BEGIN'); await c.query('LOCK TABLE workflow_runs IN SHARE MODE');
        pending=post(api.url,'forced-api').then(r=>({status:r.status}),()=>({disconnected:true}));
        await waitFor(async()=> (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='daw-api' AND wait_event_type='Lock'")).rowCount!==0,'API forced barrier');
        api.process.child.kill('SIGTERM');
        const exit=await waitFor(()=>api.process.exit??false,'API forced deadline',7500); assert.equal(exit.code,1);
        assert.ok(api.process.output.includes('shutdown_deadline')); await pending; await c.query('COMMIT');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM workflow_runs')).rows[0]?.n,0);
        const replacement=await lab.startApi(); assert.equal((await post(replacement.url,'forced-api')).status,202); record['retryAdmitted']=true;
      } finally {try{await c.query('ROLLBACK');}finally{c.release(true); if(pending) await pending;} }
    });
    for(const forced of [false,true]) await runCase(forced ? 'worker shutdown deadline forces exit and lease recovery' : 'worker SIGTERM completes current step without claiming downstream',async(pool,_api,record)=>{
      const c=await barrier(pool);
      try {
        const {run}=await createRun(pool,'local-operator','worker-drain',input), worker=await daemon('worker'); await blocked(pool);
        const started=performance.now(); worker.child.kill('SIGTERM'); await waitFor(()=>worker.output.includes('"event":"draining"'),'worker draining');
        if(!forced) await c.query('SELECT pg_advisory_unlock_all()');
        await waitFor(()=>worker.exit??false,'bounded worker shutdown',7500);
        assert.equal(worker.exit?.code,forced?1:0); record['shutdownMs']=performance.now()-started;
        if(forced) assert.ok(worker.output.includes('shutdown_deadline'));
        else assert.equal((await pool.query("SELECT attempt_count FROM step_runs WHERE step_key='build-summary'")).rows[0]?.attempt_count,0);
        await c.query('SELECT pg_advisory_unlock_all()');
        const replacement=await daemon('worker'), scheduler=await daemon('scheduler');
        await waitFor(async()=>await state(pool,run.id)==='SUCCEEDED','replacement finished',20000);
        record['snapshot']=await operationalSnapshot(pool);
        if(forced) assert.ok((record['snapshot'] as {recovered_attempts:number}).recovered_attempts>=1);
        await lab.stop(replacement); await lab.stop(scheduler);
      } finally { try{await c.query('SELECT pg_advisory_unlock_all()');}finally{c.release(true);} }
    });
    await runCase('HTTP handler capacity rejects overflow without exceeding the database pool',async(pool,api,record)=>{
      const c=await pool.connect(); let requests:Promise<Response>[]=[];
      try {
        await c.query('BEGIN'); await c.query('LOCK TABLE workflow_runs IN SHARE MODE');
        requests=Array.from({length:32},(_,i)=>post(api.url,'capacity-'+i));
        const rows=await waitFor(async()=>{const r=(await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='daw-api' AND wait_event_type='Lock'")).rows; return r.length===16?r:false;},'sixteen database connections');
        await new Promise(resolve=>setTimeout(resolve,200));
        const overflow=await fetch(api.url+'/runs',{method:'POST',headers:{authorization:`Bearer ${lab.token}`,'content-type':'application/json','idempotency-key':'overflow'},body:JSON.stringify(input),signal:AbortSignal.timeout(1500)});
        assert.equal(overflow.status,503); assert.deepEqual(await overflow.json(),{error:'overloaded'});
        assert.equal((await get(api.url,'/healthz')).status,200);
        await c.query('COMMIT'); assert.ok((await Promise.all(requests)).every(r=>r.status===202));
        record['blockedBackends']=rows; record['snapshot']=await (await get(api.url,'/operations')).json();
        assert.equal((record['snapshot'] as {api_pool_waiting:number}).api_pool_waiting,0);
      } finally { try{await c.query('ROLLBACK');}finally{c.release(true); await Promise.allSettled(requests);} }
    });
    await runCase('operational telemetry has bounded fields and exposes durable retry recovery signals',async(pool,api,record)=>{
      assert.equal((await fetch(api.url+'/operations')).status,401);
      const {run}=await createRun(pool,'local-operator','telemetry',input); const claim=await claimStep(pool,randomUUID()); assert.ok(claim);
      await failStep(pool,claim,true); const retry=await operationalSnapshot(pool); assert.equal(retry.retry_wait_steps,1); assert.equal(retry.retryable_attempts,1);
      await waitFor(async()=>{await recoverOne(pool); return (await operationalSnapshot(pool)).ready_steps===1;},'retry due');
      const snapshot=await (await get(api.url,'/operations')).json() as Record<string,unknown>;
      assert.deepEqual(Object.keys(snapshot).sort(),['schema_version','ready_steps','oldest_ready_seconds','live_leases','expired_leases','retry_wait_steps','due_retries','recovered_attempts','retryable_attempts','waiting_approval_runs','cancelled_runs','reconciliation_runs','unknown_effects','failed_runs','succeeded_runs','api_in_flight','api_pool_connections','api_pool_waiting'].sort());
      assert.ok(!JSON.stringify(snapshot).includes(run.id)); assert.ok(!JSON.stringify(snapshot).includes(input.input.title)); record['snapshot']=snapshot;
      const probes=probePool(lab.url);
      try { const begin=performance.now(); await assert.rejects(probes.query('SELECT pg_sleep(3)'),(e:{code?:string})=>e.code==='57014'); assert.ok(performance.now()-begin<2500); }
      finally { await probes.end(); }
    });
  } finally {
    await db?.end(); await lab.cleanup();
    if(process.env['DAW_EVIDENCE_DIR']) await writeFile(path.join(process.env['DAW_EVIDENCE_DIR'],'operations.json'),JSON.stringify({node:process.version,pgBin:lab.pgBin,cluster:lab.directory,cases:records,processes:lab.children.map(p=>({role:p.role,pid:p.child.pid,exit:p.exit??null}))},null,2)+'\n',{flag:'wx'});
  }
});
