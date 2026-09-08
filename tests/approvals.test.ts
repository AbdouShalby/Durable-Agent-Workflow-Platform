import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { Lab, waitFor } from './support/lab.js';
import type { OwnedProcess } from './support/lab.js';
import { createPool } from '../src/persistence/database.js';
import { migrate } from '../src/persistence/migrations.js';
import { createRun } from '../src/application/runs.js';
import { runOne } from '../src/application/worker.js';
import { recoverOne, claimStep } from '../src/application/execution.js';
import { decideApproval } from '../src/application/approvals.js';
import { executeEffect, LostEffectOwnership } from '../src/application/effects.js';
import { executeAgent } from '../src/application/agent.js';
import { deterministicAdapter } from '../src/agents/adapters.js';
import { ApprovalForbidden, actionFingerprint } from '../src/domain/approval.js';
import type { Action } from '../src/domain/approval.js';
import { effectFingerprint } from '../src/domain/effect.js';

interface Case {
  db: pg.Pool; external: pg.Pool; run: string; api: string; operator: string; human: string; apiLab: Lab;
  worker: () => OwnedProcess; restartProvider: (fault: string) => Promise<void>; record: Record<string,unknown>;
}
test('DAW-5 real PostgreSQL governed human control', { timeout: 300000 }, async t => {
  assert.ok(!process.env['DAW_AGENT_ADAPTER'] || process.env['DAW_AGENT_ADAPTER']==='deterministic','approval tests forbid live models');
  const platform = new Lab(), provider = new Lab(); let admin: pg.Pool | undefined, providerAdmin: pg.Pool | undefined;
  const cases: Record<string,unknown> = {};
  const state = async (c: Case) => (await c.db.query('SELECT state FROM workflow_runs WHERE id=$1',[c.run])).rows[0]?.state;
  const approval = async (c: Case) => (await c.db.query('SELECT * FROM approvals WHERE run_id=$1',[c.run])).rows[0];
  const writes = async (c: Case) => (await c.external.query('SELECT count(*)::int AS n FROM external_writes')).rows[0]?.n;
  const post = async (c: Case, endpoint: string, body: unknown, credential = c.human) => {
    const r = await fetch(c.api+endpoint,{ method:'POST',headers:{ authorization:`Bearer ${credential}`,'content-type':'application/json' },body:JSON.stringify(body) });
    return { status:r.status,body:await r.json() as { replayed?: boolean; state?: string } };
  };
  const decide = async (c: Case, decision: 'approve' | 'reject' = 'approve', credential = c.human) => {
    const a = await approval(c); assert.ok(a);
    return post(c,`/runs/${c.run}/approvals/${a.id}`,{ decision,action_fingerprint:a.action_fingerprint,policy_fingerprint:a.policy_fingerprint },credential);
  };
  const expire = async (c: Case) => { await c.db.query("UPDATE approvals SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[c.run]); };
  const retry = async (c: Case) => { await waitFor(async () => { await recoverOne(c.db); return (await c.db.query("SELECT 1 FROM step_runs WHERE run_id=$1 AND step_key='write-summary' AND state='READY'",[c.run])).rowCount===1; },'governed retry ready'); };
  const runCase = async (name: string, severity: 'low' | 'high', body: (c: Case) => Promise<void>, advance = true) => {
    const selected = process.env['DAW_APPROVAL_CASE'];
    if (selected && !process.env['DAW_APPROVAL_MUTATION']) throw new Error('approval selector requires mutation');
    if (selected && selected !== name) return;
    await t.test(name,async () => {
      assert.ok(admin && providerAdmin);
      const database = 'approval_'+randomUUID().replaceAll('-','');
      await admin.query(`CREATE DATABASE ${database}`); await providerAdmin.query(`CREATE DATABASE ${database}`);
      const url = new URL(platform.url), extUrl = new URL(provider.url); url.pathname = extUrl.pathname = '/'+database;
      const db = createPool(url.href,'daw-approval-observer'), external = createPool(extUrl.href);
      const apiLab = new Lab(); apiLab.url=url.href;
      const start = platform.children.length, human = randomBytes(32).toString('hex'), serviceId = randomUUID();
      const record: Record<string,unknown> = {}; cases[name]=record;
      let service: OwnedProcess | undefined, endpoint='';
      const restartProvider = async (fault: string) => {
        if (service) await provider.stop(service);
        service = provider.child('approval-external-http',process.execPath,['dist/src/simulator/server.js'],{
          ...process.env,SIMULATOR_DATABASE_URL:extUrl.href,SIMULATOR_SERVICE_ID:serviceId,SIMULATOR_PORT:endpoint ? new URL(endpoint).port:'0',SIMULATOR_FAULT:fault,
        });
        const active=service;
        endpoint=await waitFor(() => {
          if (active.failure || active.exit) throw new Error('approval simulator startup failed');
          const line=active.output.split('\n').find(l=>l.startsWith('{')); return line ? (JSON.parse(line) as {url:string}).url:false;
        },'approval simulator readiness');
      };
      try {
        await migrate(db); await restartProvider('normal');
        process.env['EFFECT_SERVICE_URL']=endpoint; process.env['EFFECT_SERVICE_ID']=serviceId;
        const created=await createRun(db,'local-operator','approval',{ workflow:'incident-triage',version:4,input:{title:'Synthetic governed incident',severity} });
        const worker = () => {
          const env: NodeJS.ProcessEnv = {...process.env,DATABASE_URL:url.href}; delete env['APPROVER_TOKEN']; delete env['OPERATOR_TOKEN'];
          return platform.child('governed-worker',process.execPath,['dist/src/entrypoints/worker.js'],env);
        };
        const api=await apiLab.startApi(human);
        if (advance) { await runOne(db,randomUUID()); await runOne(db,randomUUID()); await runOne(db,randomUUID()); }
        const c:Case={db,external,run:created.run.id,api:api.url,operator:apiLab.token,human,apiLab,worker,restartProvider,record};
        record['run']=c.run;
        await body(c);
      } catch (error) {
        record['failure'] = error instanceof Error ? { name: error.name, message: error.message } : { name: 'unknown' };
        throw error;
      } finally {
        const failures:unknown[]=[];
        for (const p of platform.children.slice(start).reverse()) { try { if (!p.exit) p.child.kill('SIGCONT'); await platform.stop(p); } catch(e) { failures.push(e); } }
        try {
          record['runs']=(await db.query('SELECT id,state,cancel_requested_at FROM workflow_runs')).rows;
          record['approvals']=(await db.query('SELECT * FROM approvals')).rows;
          record['steps']=(await db.query('SELECT step_key,state,attempt_count,result,last_error FROM step_runs ORDER BY ordinal')).rows;
          record['agentCalls']=(await db.query('SELECT call_no,turn,state FROM agent_calls ORDER BY call_no')).rows;
          record['events']=(await db.query('SELECT sequence,type,details FROM run_events ORDER BY sequence')).rows;
          record['externalWrites']=(await external.query('SELECT * FROM external_writes')).rows;
          record['externalRequests']=(await external.query('SELECT * FROM external_requests ORDER BY id')).rows;
        } catch(e) { failures.push(e); }
        for (const close of [()=>apiLab.cleanup(),()=>db.end(),()=>external.end(),()=>service ? provider.stop(service):Promise.resolve()]) { try { await close(); } catch(e) { failures.push(e); } }
        record['apiProcesses']=apiLab.children.map(p=>({pid:p.child.pid,exit:p.exit??null}));
        if (failures.length) {
          record['cleanupFailures'] = failures.map(e => e instanceof Error ? { name:e.name,message:e.message } : { name:'unknown' });
          throw new AggregateError(failures,'approval case cleanup failed');
        }
      }
    });
  };
  try {
    await platform.startPostgres(); await provider.startPostgres();
    assert.notEqual(platform.directory,provider.directory); assert.notEqual(platform.postgres?.child.pid,provider.postgres?.child.pid);
    admin=createPool(platform.url); providerAdmin=createPool(provider.url);
    await runCase('high policy durably waits without attempts or external writes','high',async c => {
      assert.equal(await state(c),'WAITING_APPROVAL'); assert.equal((await approval(c)).state,'PENDING');
      assert.equal(await runOne(c.db,randomUUID()),false); assert.equal(await writes(c),0);
      const step=(await c.db.query("SELECT attempt_count,deadline_at FROM step_runs WHERE step_key='write-summary'")).rows[0];
      assert.deepEqual(step,{attempt_count:0,deadline_at:null});
      const response=await fetch(c.api+'/runs/'+c.run,{headers:{authorization:`Bearer ${c.human}`}});
      assert.equal(response.status,200);
      const preview=await response.json() as {approval:{action_fingerprint:string;expires_at:string};approval_action:Action & {policy_version:string;policy_fingerprint:string}};
      assert.equal(actionFingerprint(preview.approval_action,preview.approval_action),preview.approval.action_fingerprint);
      assert.equal(preview.approval_action.request.summary,'[HIGH] Synthetic governed incident');
      assert.ok(preview.approval.expires_at); assert.ok(preview.approval_action.service_url.startsWith('http://127.0.0.1:'));
    });
    await runCase('low policy executes the existing tool without requiring approval','low',async c => {
      assert.equal(await approval(c),undefined); await runOne(c.db,randomUUID());
      assert.equal(await state(c),'SUCCEEDED'); assert.equal(await writes(c),1);
    });
    await runCase('eight concurrent human approvals serialize and execute one logical action','high',async c => {
      const a=await approval(c), blocker=await c.db.connect(); let pending:Promise<{status:number;body:{replayed?:boolean;state?:string}}>[]= [];
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE',[c.run]);
        pending=Array.from({length:8},()=>post(c,`/runs/${c.run}/approvals/${a.id}`,{decision:'approve',action_fingerprint:a.action_fingerprint,policy_fingerprint:a.policy_fingerprint}));
        const sessions=await waitFor(async()=>{ const rows=(await c.db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='daw-api' AND wait_event_type='Lock' AND state='active'")).rows; return rows.length===8 ? rows:false; },'eight blocked approval sessions');
        c.record['blockedApprovalBackends']=sessions; await blocker.query('COMMIT');
        const replies=await Promise.all(pending); assert.ok(replies.every(r=>r.status===200)); assert.equal(replies.filter(r=>!r.body.replayed).length,1);
      } finally { try { await blocker.query('ROLLBACK'); } finally { blocker.release(true); await Promise.allSettled(pending); } }
      const workers=Array.from({length:4},()=>c.worker());
      await waitFor(async()=>await state(c)==='SUCCEEDED','approved action completed',15000);
      for (const p of workers) await platform.stop(p);
      assert.equal(await writes(c),1);
      assert.equal((await c.external.query("SELECT count(*)::int AS n FROM external_requests WHERE method='POST'")).rows[0]?.n,1);
      assert.equal((await c.db.query("SELECT attempt_count FROM step_runs WHERE step_key='write-summary'")).rows[0]?.attempt_count,1);
      assert.equal((await c.db.query("SELECT count(*)::int AS n FROM run_events WHERE type='APPROVAL_DECIDED'")).rows[0]?.n,1);
      assert.equal((await decide(c)).body.replayed,true); assert.equal((await decide(c,'reject')).status,409);
    });
    await runCase('operator and agent cannot grant approval at HTTP or engine boundary','high',async c => {
      assert.equal((await decide(c,'approve',c.operator)).status,403);
      const a=await approval(c);
      await assert.rejects(decideApproval(c.db,{role:'agent',id:'local-approver'},c.run,a.id,{decision:'approve',action_fingerprint:a.action_fingerprint,policy_fingerprint:a.policy_fingerprint}),ApprovalForbidden);
      assert.equal((await approval(c)).state,'PENDING'); assert.equal(await writes(c),0);
      const missing=await c.apiLab.startApi(); const saved=c.api; c.api=missing.url;
      try { assert.equal((await decide(c)).status,403); } finally { c.api=saved; }
    });
    await runCase('API and worker restart preserve waiting approval and accepted decisions','high',async c => {
      const before=await approval(c), worker=c.worker(); await platform.stop(worker,'SIGKILL');
      await c.apiLab.cleanup(); c.api=(await c.apiLab.startApi(c.human)).url;
      assert.equal((await approval(c)).id,before.id); assert.equal(await state(c),'WAITING_APPROVAL');
      assert.equal((await decide(c)).status,200); const replacement=c.worker();
      await waitFor(async()=>await state(c)==='SUCCEEDED','resume after human approval',15000); await platform.stop(replacement);
      assert.equal((await c.db.query('SELECT count(*)::int AS n FROM agent_calls')).rows[0]?.n,2); assert.equal(await writes(c),1);
    });
    await runCase('rejected approval is terminal and duplicate rejection is harmless','high',async c => {
      assert.equal((await decide(c,'reject')).status,200); assert.equal((await decide(c,'reject')).body.replayed,true);
      assert.equal((await decide(c)).status,409); assert.equal(await runOne(c.db,randomUUID()),false);
      assert.equal(await state(c),'FAILED'); assert.equal(await writes(c),0);
    });
    await runCase('expired pending approval cannot unblock and scheduler persists expiry','high',async c => {
      await expire(c); assert.equal(await recoverOne(c.db),true);
      assert.equal((await approval(c)).state,'EXPIRED'); assert.equal((await decide(c)).status,409);
      assert.equal(await runOne(c.db,randomUUID()),false); assert.equal(await writes(c),0);
    });
    await runCase('approved grant expired before dispatch cannot authorize a POST','high',async c => {
      assert.equal((await decide(c)).status,200); await expire(c); await runOne(c.db,randomUUID());
      assert.equal(await state(c),'FAILED'); assert.equal((await approval(c)).state,'EXPIRED'); assert.equal(await writes(c),0);
    });
    await runCase('changed action fingerprint invalidates an approved grant before dispatch','high',async c => {
      await decide(c); const payload={summary:'Changed proposed transaction'};
      await c.db.query('UPDATE tool_invocations SET request=$1,request_fingerprint=$2',[payload,effectFingerprint(payload)]);
      await c.db.query("UPDATE step_runs SET result=jsonb_set(result,'{summary}',$1::jsonb) WHERE step_key='analyze-incident'",[JSON.stringify(payload.summary)]);
      await runOne(c.db,randomUUID());
      assert.equal((await approval(c)).state,'INVALIDATED'); assert.equal(await state(c),'FAILED'); assert.equal(await writes(c),0);
    });
    await runCase('changed policy fingerprint cannot reuse an earlier human approval','high',async c => {
      await decide(c); await c.db.query("UPDATE governed_actions SET policy_version='changed-policy',policy_fingerprint=$1",['0'.repeat(64)]);
      await runOne(c.db,randomUUID()); assert.equal((await approval(c)).state,'INVALIDATED'); assert.equal(await writes(c),0);
    });
    await runCase('approval endpoints reject stale fingerprints and foreign identities','high',async c => {
      const a=await approval(c), body={decision:'approve',action_fingerprint:a.action_fingerprint,policy_fingerprint:a.policy_fingerprint};
      assert.equal((await post(c,`/runs/${c.run}/approvals/${a.id}`,{...body,action_fingerprint:'0'.repeat(64)})).status,409);
      assert.equal((await post(c,`/runs/${randomUUID()}/approvals/${a.id}`,body)).status,404);
      assert.equal((await post(c,`/runs/${c.run}/approvals/${a.id}`,{...body,approved:true})).status,400);
      assert.equal((await approval(c)).state,'PENDING'); assert.equal(await writes(c),0);
    });
    await runCase('concurrent cancellation and approval leave no executable cancelled work','high',async c => {
      const blocker=await c.db.connect(); let pending:Promise<{status:number;body:{replayed?:boolean;state?:string}}>[]= [];
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM workflow_runs WHERE id=$1 FOR UPDATE',[c.run]);
        pending=[decide(c),post(c,`/runs/${c.run}/cancel`,{},c.operator)];
        await waitFor(async()=> (await c.db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='daw-api' AND wait_event_type='Lock' AND state='active'")).rows[0]?.n===2,'cancel approval lock race');
        await blocker.query('COMMIT'); const results=await Promise.all(pending);
        assert.ok([200,409].includes(results[0]!.status)); assert.equal(results[1]!.status,200);
      } finally { try { await blocker.query('ROLLBACK'); } finally { blocker.release(true); await Promise.allSettled(pending); } }
      assert.equal(await state(c),'CANCELLED'); assert.equal(await runOne(c.db,randomUUID()),false); assert.equal(await writes(c),0);
      assert.equal((await post(c,`/runs/${c.run}/cancel`,{},c.operator)).body.replayed,true);
    });
    await runCase('cancellation before dispatch fences a claimed worker','high',async c => {
      await decide(c); const claim=await claimStep(c.db,randomUUID()); assert.ok(claim);
      assert.equal((await post(c,`/runs/${c.run}/cancel`,{},c.operator)).body.state,'CANCELLED');
      await assert.rejects(executeEffect(c.db,claim,new AbortController().signal),LostEffectOwnership); assert.equal(await writes(c),0);
    });
    await runCase('cancellation after external authorization requires reconciliation not rollback','high',async c => {
      await c.restartProvider('hold-response'); await decide(c); const worker=c.worker();
      await waitFor(async()=>await writes(c)===1,'external write before cancel');
      worker.child.kill('SIGSTOP');
      assert.equal((await post(c,`/runs/${c.run}/cancel`,{},c.operator)).body.state,'RECONCILIATION_REQUIRED');
      await platform.stop(worker,'SIGKILL');
      assert.equal(await state(c),'RECONCILIATION_REQUIRED'); assert.equal(await runOne(c.db,randomUUID()),false);
      assert.equal(await writes(c),1); assert.equal((await decide(c)).status,409);
    });
    await runCase('expired authorization permits receipt verification but not another write','high',async c => {
      await c.restartProvider('hold-response'); await decide(c); await runOne(c.db,randomUUID()); await expire(c);
      await c.restartProvider('normal'); await retry(c); await runOne(c.db,randomUUID());
      assert.equal(await state(c),'SUCCEEDED'); assert.equal(await writes(c),1);
      assert.equal((await c.external.query("SELECT count(*)::int AS n FROM external_requests WHERE method='POST'")).rows[0]?.n,1);
    });
    await runCase('not-found reconciliation cannot resend after approval expiry','high',async c => {
      await c.restartProvider('reject-before-write'); await decide(c); await runOne(c.db,randomUUID()); await expire(c);
      await c.restartProvider('normal'); await retry(c); await runOne(c.db,randomUUID());
      assert.equal(await state(c),'RECONCILIATION_REQUIRED'); assert.equal(await writes(c),0);
      assert.equal((await c.external.query("SELECT count(*)::int AS n FROM external_requests WHERE method='POST'")).rows[0]?.n,1);
    });
    await runCase('approval insertion failure rolls back agent completion and reuses its checkpoint','high',async c => {
      await runOne(c.db,randomUUID()); await runOne(c.db,randomUUID());
      await c.db.query("UPDATE step_runs SET lease_ms=600 WHERE step_key='analyze-incident'");
      await c.db.query("CREATE FUNCTION fail_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected approval failure'; END $$; CREATE TRIGGER fail_approval BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION fail_approval()");
      await assert.rejects(runOne(c.db,randomUUID()));
      assert.equal((await c.db.query('SELECT count(*)::int AS n FROM approvals')).rows[0]?.n,0);
      assert.equal((await c.db.query('SELECT count(*)::int AS n FROM tool_invocations')).rows[0]?.n,0);
      await c.db.query('DROP TRIGGER fail_approval ON approvals');
      await waitFor(async()=>{await recoverOne(c.db); return (await c.db.query("SELECT 1 FROM step_runs WHERE step_key='analyze-incident' AND state='READY'")).rowCount===1;},'approval rollback recovery');
      await runOne(c.db,randomUUID()); assert.equal(await state(c),'WAITING_APPROVAL');
      assert.equal((await c.db.query('SELECT count(*)::int AS n FROM agent_calls')).rows[0]?.n,2);
    },false);
    await runCase('model cannot create approvals from accepted output fields','high',async c => {
      await runOne(c.db,randomUUID()); await runOne(c.db,randomUUID());
      await runOne(c.db,randomUUID(),(claim,signal)=>executeAgent(c.db,claim,signal,{async decide(context,s){
        const raw=JSON.parse(await deterministicAdapter.decide(context,s)) as Record<string,unknown>;
        return JSON.stringify({...raw,approved:true});
      }}));
      assert.equal(await state(c),'FAILED'); assert.equal(await approval(c),undefined); assert.equal(await writes(c),0);
    },false);
    await runCase('governed summary must fit the unchanged existing tool contract','high',async c => {
      await runOne(c.db,randomUUID()); await runOne(c.db,randomUUID());
      await runOne(c.db,randomUUID(),(claim,signal)=>executeAgent(c.db,claim,signal,{async decide(context,s){
        const raw=JSON.parse(await deterministicAdapter.decide(context,s)) as Record<string,unknown>;
        return JSON.stringify(raw['kind']==='finish' ? {...raw,summary:'x'.repeat(301)}:raw);
      }}));
      assert.equal(await state(c),'FAILED'); assert.equal(await approval(c),undefined); assert.equal(await writes(c),0);
    },false);
  } finally {
    const failures:unknown[]=[];
    for (const close of [()=>admin?.end(),()=>providerAdmin?.end(),()=>platform.cleanup(),()=>provider.cleanup()]) { try { await close(); } catch(e) { failures.push(e); } }
    if (process.env['DAW_EVIDENCE_DIR']) await writeFile(path.join(process.env['DAW_EVIDENCE_DIR'],'approvals.json'),JSON.stringify({node:process.version,pgBin:platform.pgBin,
      independentClusters:[platform.directory,provider.directory],cases,processes:[...platform.children,...provider.children].map(p=>({role:p.role,pid:p.child.pid,exit:p.exit??null}))},null,2)+'\n',{flag:'wx'});
    if (failures.length) throw new AggregateError(failures,'approval suite cleanup failed');
  }
});
