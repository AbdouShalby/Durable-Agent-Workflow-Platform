import type pg from 'pg';
import { transaction, lockStep, owns, event } from './execution.js';
import type { Claim } from './execution.js';
import { acceptDecision, readTool, finalAgentResult, AgentPolicyError, AgentBudgetError, modelSnapshot } from '../domain/agent.js';
import type { Checkpoint, AgentDecision, Observation } from '../domain/agent.js';
import { configuredAdapter, ModelUnavailable } from '../agents/adapters.js';
import type { LlmAdapter } from '../agents/adapters.js';
import { agentDefinitionHash, governedDefinitionHash } from '../domain/workflow.js';

export class LostAgentOwnership extends Error {}
export class AgentInfrastructureError extends Error {}
interface Session {
  adapter: string; model: string; max_turns: number; max_calls: number; max_tool_calls: number;
  max_cost_micros: number; call_cost_micros: number; call_timeout_ms: number;
  calls: number; tool_calls: number; reserved_cost_micros: number;
}

async function owned<T>(pool: pg.Pool, claim: Claim, operation: (client: pg.PoolClient, row: Session) => Promise<T>): Promise<T> {
  try {
    return await transaction(pool, async client => {
      await lockStep(client, claim.run_id, claim.step_key);
      if (!await owns(client, claim)) throw new LostAgentOwnership();
      const row = (await client.query<Session>('SELECT * FROM agent_sessions WHERE run_id=$1 AND step_key=$2', [claim.run_id,claim.step_key])).rows[0];
      if (!row || row.model !== modelSnapshot) throw new AgentPolicyError('unsupported agent session');
      return operation(client, row);
    });
  } catch (error) {
    if (error instanceof LostAgentOwnership || error instanceof AgentPolicyError) throw error;
    throw new AgentInfrastructureError('agent storage unavailable');
  }
}
async function history(client: pg.PoolClient, claim: Claim): Promise<Checkpoint[]> {
  return (await client.query<Checkpoint>('SELECT turn,decision,observation FROM agent_decisions WHERE run_id=$1 AND step_key=$2 ORDER BY turn', [claim.run_id,claim.step_key])).rows;
}
export async function saveAgentDecision(pool: pg.Pool, claim: Claim, call: number, raw: string): Promise<AgentDecision> {
  return owned(pool, claim, async client => {
    const record = (await client.query<{ turn: number; fence: number; state: string }>('SELECT turn,fence,state FROM agent_calls WHERE run_id=$1 AND step_key=$2 AND call_no=$3', [claim.run_id,claim.step_key,call])).rows[0];
    if (!record || record.fence !== claim.fence || record.state !== 'RESERVED') throw new LostAgentOwnership();
    const checkpoints = await history(client, claim);
    if (record.turn !== checkpoints.length + 1) throw new AgentPolicyError('nonsequential agent decision');
    const decision = acceptDecision(raw, checkpoints);
    await client.query('INSERT INTO agent_decisions(run_id,step_key,turn,call_no,decision) VALUES($1,$2,$3,$4,$5)', [claim.run_id,claim.step_key,record.turn,call,decision]);
    await client.query("UPDATE agent_calls SET state='ACCEPTED' WHERE run_id=$1 AND step_key=$2 AND call_no=$3", [claim.run_id,claim.step_key,call]);
    await event(client, claim.run_id, 'AGENT_DECISION_ACCEPTED', { turn: record.turn, call, kind: decision.kind });
    return decision;
  });
}
async function observe(pool: pg.Pool, claim: Claim, checkpoint: Checkpoint): Promise<void> {
  await owned(pool, claim, async (client, row) => {
    if (row.tool_calls >= row.max_tool_calls) throw new AgentBudgetError('agent tool budget exhausted');
    await client.query('UPDATE agent_sessions SET tool_calls=tool_calls+1 WHERE run_id=$1 AND step_key=$2', [claim.run_id,claim.step_key]);
  });
  const observation: Observation = readTool(checkpoint.decision, claim.input, checkpoint.turn);
  await owned(pool, claim, async client => {
    const saved = await client.query('UPDATE agent_decisions SET observation=$4 WHERE run_id=$1 AND step_key=$2 AND turn=$3 AND observation IS NULL', [claim.run_id,claim.step_key,checkpoint.turn,observation]);
    if (saved.rowCount !== 1) throw new AgentPolicyError('observation already saved');
    await event(client, claim.run_id, 'AGENT_OBSERVATION_SAVED', { turn: checkpoint.turn, observation: observation.id });
  });
}

async function rejectCall(pool: pg.Pool, claim: Claim, call: number): Promise<void> {
  await owned(pool, claim, async client => {
    await client.query("UPDATE agent_calls SET state='REJECTED' WHERE run_id=$1 AND step_key=$2 AND call_no=$3 AND state='RESERVED'", [claim.run_id,claim.step_key,call]);
    await event(client, claim.run_id, 'AGENT_OUTPUT_REJECTED', { call });
  });
}
/** Iteration state is durable. An accepted model decision is never generated again on resume. */
export async function executeAgent(pool: pg.Pool, claim: Claim, signal: AbortSignal, injected?: LlmAdapter): Promise<unknown> {
  if (claim.workflow_name !== 'incident-triage' || !((claim.workflow_version === 3 && claim.definition_hash === agentDefinitionHash) ||
      (claim.workflow_version === 4 && claim.definition_hash === governedDefinitionHash)) || claim.step_key !== 'analyze-incident') throw new AgentPolicyError('unsupported agent definition');
  while (true) {
    signal.throwIfAborted();
    const checkpoints = await owned(pool, claim, client => history(client, claim));
    const last = checkpoints.at(-1);
    if (last?.decision.kind === 'finish') {
      if (claim.workflow_version === 4 && (last.decision.summary?.length ?? 0) > 300) throw new AgentPolicyError('governed summary exceeds tool contract');
      return finalAgentResult(last.decision);
    }
    if (last && last.observation === null) { await observe(pool, claim, last); continue; }
    const reservation = await owned(pool, claim, async (client, row) => {
      const turn = checkpoints.length + 1;
      if (turn > row.max_turns) throw new AgentBudgetError('agent turn budget exhausted');
      if (row.calls >= row.max_calls || row.reserved_cost_micros + row.call_cost_micros > row.max_cost_micros) throw new AgentBudgetError('agent call or cost budget exhausted');
      const call = row.calls + 1;
      await client.query('UPDATE agent_sessions SET calls=$3,reserved_cost_micros=reserved_cost_micros+call_cost_micros WHERE run_id=$1 AND step_key=$2', [claim.run_id,claim.step_key,call]);
      await client.query('INSERT INTO agent_calls(run_id,step_key,call_no,turn,fence,reserved_cost_micros) VALUES($1,$2,$3,$4,$5,$6)', [claim.run_id,claim.step_key,call,turn,claim.fence,row.call_cost_micros]);
      await event(client, claim.run_id, 'AGENT_CALL_RESERVED', { call, turn, reserved_cost_micros: row.call_cost_micros });
      const remaining = Number((await client.query('SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 AS ms', [claim.deadline_at])).rows[0]?.ms);
      return { call, adapter: row.adapter, timeout: Math.max(1, Math.floor(Math.min(row.call_timeout_ms, remaining))) };
    });
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    let timer: NodeJS.Timeout | undefined;
    let raw: string;
    try {
      const context = structuredClone({ incident: claim.input, checkpoints });
      if (Buffer.byteLength(JSON.stringify(context)) > 8192) throw new AgentPolicyError('agent context too large');
      const adapter = injected ?? configuredAdapter(reservation.adapter);
      raw = await Promise.race([
        adapter.decide(context, combined),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new ModelUnavailable('model deadline exceeded')); }, reservation.timeout); }),
      ]);
    } catch (error) {
      if (error instanceof AgentPolicyError) await rejectCall(pool, claim, reservation.call);
      throw error;
    } finally { if (timer) clearTimeout(timer); }
    try { await saveAgentDecision(pool, claim, reservation.call, raw); }
    catch (error) {
      if (error instanceof AgentPolicyError) await rejectCall(pool, claim, reservation.call);
      throw error;
    }
  }
}
