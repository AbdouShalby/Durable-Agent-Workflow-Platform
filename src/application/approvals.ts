import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction, lockStep, event } from './execution.js';
import type { Claim } from './execution.js';
import { actionFingerprint, approvalPolicy, policyFingerprint, requireHuman, ApprovalConflict, ApprovalForbidden, ApprovalNotFound } from '../domain/approval.js';
import type { Action, Principal } from '../domain/approval.js';
import { effectKey, effectFingerprint } from '../domain/effect.js';
import { governedDefinitionHash } from '../domain/workflow.js';

interface Policy { policy_version: string; policy_fingerprint: string; requires_approval: boolean; service_id: string; service_url: string }
interface Approval {
  id: string; run_id: string; step_key: string; tool: string; action_fingerprint: string;
  policy_version: string; policy_fingerprint: string; state: string; expires_at: Date;
  decision: 'approve' | 'reject' | null; decided_by: string | null; authorized_at: Date | null;
}
interface Run { id: string; caller_id: string; workflow_version: number; definition_hash: string; state: string; input: { severity: string }; cancel_requested_at: Date | null }
const loadRun = async (c: pg.PoolClient, id: string) => (await c.query<Run>('SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
const loadPolicy = async (c: pg.PoolClient, id: string) => (await c.query<Policy>('SELECT * FROM governed_actions WHERE run_id=$1', [id])).rows[0];
const loadAction = async (c: pg.PoolClient, id: string) => (await c.query<Action & { state: string }>("SELECT * FROM tool_invocations WHERE run_id=$1 AND step_key='write-summary'", [id])).rows[0];
const loadApproval = async (c: pg.PoolClient, id: string) => (await c.query<Approval>('SELECT * FROM approvals WHERE run_id=$1 FOR UPDATE', [id])).rows[0];
function validPolicy(run: Run, policy: Policy): boolean {
  return run.workflow_version === 4 && run.definition_hash === governedDefinitionHash && policy.policy_version === approvalPolicy.version &&
    policy.policy_fingerprint === policyFingerprint && policy.requires_approval === (run.input.severity === 'high');
}
function bindingMatches(run: Run, policy: Policy, action: Action, approval: Approval): boolean {
  return validPolicy(run, policy) && action.service_id === policy.service_id && action.service_url === policy.service_url &&
    action.contract === 'keyed' && action.effect_key === effectKey(run.id,4) && action.request_fingerprint === effectFingerprint(action.request) &&
    approval.run_id === run.id && approval.step_key === action.step_key && approval.tool === 'write-summary' &&
    approval.policy_version === policy.policy_version && approval.policy_fingerprint === policy.policy_fingerprint &&
    approval.action_fingerprint === actionFingerprint(action, policy);
}

/** Caller owns the run/agent-step locks; completion, intent and approval/schedule are one commit. */
export async function scheduleGovernedAction(c: pg.PoolClient, claim: Claim, result: unknown): Promise<boolean> {
  if (claim.workflow_version !== 4 || claim.step_key !== 'analyze-incident') return false;
  const run = await loadRun(c,claim.run_id), policy = await loadPolicy(c,claim.run_id);
  const summary = (result as { summary?: unknown } | null)?.summary;
  if (!run || !policy || !validPolicy(run,policy) || typeof summary !== 'string' || !summary.trim() || summary.length > 300) throw new Error('invalid governed proposal');
  const payload = { summary };
  const action: Action = { run_id: run.id, step_key: 'write-summary', effect_key: effectKey(run.id,4), contract: 'keyed',
    service_id: policy.service_id, service_url: policy.service_url, request: payload, request_fingerprint: effectFingerprint(payload) };
  await c.query(`INSERT INTO tool_invocations(run_id,step_key,effect_key,contract,service_id,service_url,request,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [run.id,action.step_key,action.effect_key,action.contract,action.service_id,action.service_url,payload,action.request_fingerprint]);
  if (!policy.requires_approval) return false;
  const id = randomUUID();
  await c.query(`INSERT INTO approvals(id,run_id,step_key,tool,action_fingerprint,policy_version,policy_fingerprint,state,expires_at)
    VALUES($1,$2,'write-summary','write-summary',$3,$4,$5,'PENDING',clock_timestamp()+$6*interval '1 millisecond')`,
  [id,run.id,actionFingerprint(action,policy),policy.policy_version,policy.policy_fingerprint,approvalPolicy.ttlMs]);
  await c.query("UPDATE step_runs SET state='WAITING_APPROVAL',available_at=NULL WHERE run_id=$1 AND step_key='write-summary'", [run.id]);
  await c.query("UPDATE workflow_runs SET state='WAITING_APPROVAL' WHERE id=$1", [run.id]);
  await event(c,run.id,'APPROVAL_REQUESTED',{ approval_id: id, action_fingerprint: actionFingerprint(action,policy), policy_fingerprint: policy.policy_fingerprint });
  return true;
}

async function invalidate(c: pg.PoolClient, run: string, state: 'EXPIRED' | 'INVALIDATED' | 'REJECTED'): Promise<void> {
  const action = await loadAction(c,run), uncertain = action && action.state !== 'PREPARED';
  await c.query('UPDATE approvals SET state=$2 WHERE run_id=$1', [run,state]);
  await c.query("UPDATE step_attempts SET outcome='PERMANENT',ended_at=clock_timestamp(),error_code=$2 WHERE run_id=$1 AND outcome='RUNNING'", [run,'APPROVAL_' + state]);
  await c.query("UPDATE step_runs SET state=$2,owner=NULL,lease_expires_at=NULL,available_at=NULL,last_error=$3 WHERE run_id=$1 AND step_key='write-summary' AND state<>'SUCCEEDED'", [run,uncertain ? 'UNKNOWN':'FAILED','APPROVAL_' + state]);
  await c.query('UPDATE workflow_runs SET state=$2 WHERE id=$1', [run,uncertain ? 'RECONCILIATION_REQUIRED':'FAILED']);
  await event(c,run,state === 'REJECTED' ? 'APPROVAL_DECIDED' : 'APPROVAL_' + state,{ state, reconciliation_required: !!uncertain });
}

/** Rechecked at each HTTP authorization boundary; never trust a boolean from a model/client. */
export async function guardEffectApproval(c: pg.PoolClient, claim: Claim, mode: 'prepare' | 'send' | 'verify'): Promise<boolean> {
  if (claim.workflow_version !== 4) return true;
  const run = await loadRun(c,claim.run_id), policy = await loadPolicy(c,claim.run_id), action = await loadAction(c,claim.run_id);
  if (!run || run.cancel_requested_at || run.state !== 'RUNNING') return false;
  if (!policy || !action || !validPolicy(run,policy) || action.service_id !== policy.service_id || action.service_url !== policy.service_url ||
      action.contract !== 'keyed' || action.effect_key !== effectKey(run.id,4) || action.request_fingerprint !== effectFingerprint(action.request)) {
    await invalidate(c,run.id,'INVALIDATED'); return false;
  }
  if (!policy.requires_approval) return true;
  const approval = await loadApproval(c,run.id);
  if (!approval || !bindingMatches(run,policy,action,approval)) { await invalidate(c,run.id,'INVALIDATED'); return false; }
  if (approval.state !== 'APPROVED' || approval.decision !== 'approve' || approval.decided_by !== 'local-approver') { await invalidate(c,run.id,'INVALIDATED'); return false; }
  if (mode === 'verify') {
    if (approval.authorized_at) return true;
    await invalidate(c,run.id,'INVALIDATED'); return false;
  }
  const live = (await c.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()', [approval.expires_at])).rowCount === 1;
  if (!live) { await invalidate(c,run.id,'EXPIRED'); return false; }
  if (!approval.authorized_at) {
    await c.query('UPDATE approvals SET authorized_at=clock_timestamp() WHERE id=$1', [approval.id]);
    await event(c,run.id,'APPROVAL_AUTHORIZED',{ approval_id: approval.id, action_fingerprint: approval.action_fingerprint });
  }
  return true;
}

export interface ApprovalDecision { decision: 'approve' | 'reject'; action_fingerprint: string; policy_fingerprint: string }
export async function decideApproval(pool: pg.Pool, principal: Principal, runId: string, approvalId: string, input: ApprovalDecision): Promise<{ replayed: boolean; state: string }> {
  requireHuman(principal);
  const result = await transaction(pool,async c => {
    const run = await loadRun(c,runId);
    if (!run || run.caller_id !== 'local-operator') throw new ApprovalNotFound();
    await lockStep(c,runId,'write-summary');
    const approval = await loadApproval(c,runId), policy = await loadPolicy(c,runId), action = await loadAction(c,runId);
    if (!approval || approval.id !== approvalId || !policy || !action) throw new ApprovalNotFound();
    if (!['approve','reject'].includes(input.decision) || input.action_fingerprint !== approval.action_fingerprint || input.policy_fingerprint !== approval.policy_fingerprint) throw new ApprovalConflict();
    if (run.cancel_requested_at) throw new ApprovalConflict();
    if (run.state === 'SUCCEEDED' || run.state === 'FAILED') {
      if (((run.state === 'SUCCEEDED' && approval.state === 'APPROVED') || (run.state === 'FAILED' && approval.state === 'REJECTED')) &&
          approval.decision === input.decision && bindingMatches(run,policy,action,approval)) return { replayed: true, state: approval.state };
      throw new ApprovalConflict();
    }
    if (!['WAITING_APPROVAL','RUNNING'].includes(run.state)) throw new ApprovalConflict();
    if (!bindingMatches(run,policy,action,approval)) { await invalidate(c,runId,'INVALIDATED'); return null; }
    const live = (await c.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()', [approval.expires_at])).rowCount === 1;
    if (!live && !approval.authorized_at) { await invalidate(c,runId,'EXPIRED'); return null; }
    if (approval.state !== 'PENDING') {
      if (approval.state === 'APPROVED' && approval.decision === input.decision) return { replayed: true, state: approval.state };
      throw new ApprovalConflict();
    }
    await c.query('UPDATE approvals SET decision=$2,decided_by=$3,decided_at=clock_timestamp(),state=$4 WHERE id=$1',
      [approval.id,input.decision,principal.id,input.decision==='approve' ? 'APPROVED':'REJECTED']);
    if (input.decision === 'reject') await invalidate(c,runId,'REJECTED');
    else {
      await c.query("UPDATE step_runs SET state='READY',available_at=clock_timestamp() WHERE run_id=$1 AND step_key='write-summary' AND state='WAITING_APPROVAL'", [runId]);
      await c.query("UPDATE workflow_runs SET state='RUNNING' WHERE id=$1", [runId]);
      await event(c,runId,'APPROVAL_DECIDED',{ approval_id: approval.id, decision: input.decision, actor: principal.id });
    }
    return { replayed: false, state: input.decision === 'approve' ? 'APPROVED':'REJECTED' };
  });
  if (!result) throw new ApprovalConflict();
  return result;
}

export async function recoverApprovalOne(pool: pg.Pool): Promise<boolean> {
  return transaction(pool,async c => {
    const run = (await c.query<{ id: string }>(`SELECT r.id FROM workflow_runs r WHERE r.state IN ('WAITING_APPROVAL','RUNNING')
      AND EXISTS (SELECT 1 FROM approvals a WHERE a.run_id=r.id AND a.state IN ('PENDING','APPROVED') AND a.authorized_at IS NULL AND a.expires_at<=clock_timestamp())
      ORDER BY r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
    if (!run) return false;
    await lockStep(c,run.id,'write-summary');
    await invalidate(c,run.id,'EXPIRED'); return true;
  });
}

export async function cancelRun(pool: pg.Pool, principal: Principal, runId: string): Promise<{ state: string; replayed: boolean }> {
  if (principal.role !== 'operator' || principal.id !== 'local-operator') throw new ApprovalForbidden();
  return transaction(pool,async c => {
    const run = await loadRun(c,runId);
    if (!run || run.caller_id !== principal.id) throw new ApprovalNotFound();
    // Cancellation is introduced for v4 only; historical definitions keep their contract.
    if (run.workflow_version !== 4) throw new ApprovalConflict();
    if (run.cancel_requested_at) return { state: run.state, replayed: true };
    if (['SUCCEEDED','FAILED','CANCELLED'].includes(run.state)) throw new ApprovalConflict();
    await c.query('SELECT step_key FROM step_runs WHERE run_id=$1 ORDER BY ordinal FOR UPDATE', [runId]);
    const action = await loadAction(c,runId);
    const uncertain = !!action && action.state !== 'PREPARED';
    const state = uncertain ? 'RECONCILIATION_REQUIRED':'CANCELLED';
    await c.query('UPDATE workflow_runs SET state=$2,cancel_requested_at=clock_timestamp() WHERE id=$1', [runId,state]);
    await c.query("UPDATE step_attempts SET outcome='CANCELLED',ended_at=clock_timestamp(),error_code='CANCELLED' WHERE run_id=$1 AND outcome='RUNNING'", [runId]);
    await c.query(`UPDATE step_runs SET state=CASE WHEN $2 AND step_key='write-summary' THEN 'UNKNOWN' ELSE 'CANCELLED' END,
      owner=NULL,lease_expires_at=NULL,available_at=NULL,last_error='CANCELLED' WHERE run_id=$1 AND state<>'SUCCEEDED'`, [runId,uncertain]);
    await c.query("UPDATE approvals SET state='CANCELLED' WHERE run_id=$1 AND state IN ('PENDING','APPROVED')", [runId]);
    await event(c,runId,uncertain ? 'CANCEL_REQUESTED':'RUN_CANCELLED',{ actor: principal.id, reconciliation_required: uncertain });
    return { state, replayed: false };
  });
}
