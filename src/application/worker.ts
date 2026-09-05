import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { claimStep, completeStep, failStep, renewLease } from './execution.js';
import type { Claim } from './execution.js';
import { definition, definitionHash, effectDefinitionHash, normalizeIncident, summarizeIncident } from '../domain/workflow.js';
import { executeEffect, EffectUncertainError, LostEffectOwnership, EffectInfrastructureError } from './effects.js';
import type { IncidentInput } from '../domain/workflow.js';
import { agentDefinitionHash } from '../domain/workflow.js';
import { executeAgent, LostAgentOwnership, AgentInfrastructureError } from './agent.js';
import { ModelUnavailable } from '../agents/adapters.js';

export class RetryableStepError extends Error {}
export type Executor = (claim: Claim, signal: AbortSignal) => Promise<unknown>;

/** Pinned pure steps shared by v1/v2. The external step is dispatched separately. */
export const executeDeterministic: Executor = async claim => {
  if (claim.workflow_name !== definition.name || !((claim.workflow_version === definition.version && claim.definition_hash === definitionHash) ||
      (claim.workflow_version === 2 && claim.definition_hash === effectDefinitionHash) ||
      (claim.workflow_version === 3 && claim.definition_hash === agentDefinitionHash))) {
    throw new Error('unsupported workflow definition');
  }
  if (claim.step_key === 'normalize-incident') return normalizeIncident(claim.input);
  if (claim.step_key === 'build-summary') {
    const prior = claim.previous_result as Partial<IncidentInput> | null;
    if (!prior || typeof prior.title !== 'string' || (prior.severity !== 'low' && prior.severity !== 'high')) throw new Error('invalid saved prior result');
    return summarizeIncident({ title: prior.title, severity: prior.severity });
  }
  throw new Error('unsupported step');
};

/** No transaction spans execution. Lost leases/DB uncertainty defer to reconciliation; only explicit failures schedule retries. */
export async function runOne(pool: pg.Pool, owner: string, execute?: Executor): Promise<boolean> {
  const claim = await claimStep(pool, owner);
  if (!claim) return false;
  const execution = new AbortController(), heartbeat = new AbortController();
  let lost = false;
  const renewal = (async () => {
    while (!heartbeat.signal.aborted) {
      try { await sleep(Math.floor(claim.lease_ms / 3), undefined, { signal: heartbeat.signal }); }
      catch { break; }
      if (heartbeat.signal.aborted) break;
      try { if (!await renewLease(pool, claim)) lost = true; }
      catch { lost = true; }
      if (lost) { execution.abort(); break; }
    }
  })();
  let result: unknown, failure: unknown, failed = false;
  try {
    if (execute) result = await execute(claim, execution.signal);
    else if (claim.workflow_name === definition.name && claim.workflow_version === 3 && claim.definition_hash === agentDefinitionHash && claim.step_key === 'analyze-incident') {
      result = await executeAgent(pool, claim, execution.signal);
    } else if (claim.workflow_name === definition.name && claim.workflow_version === 2 && claim.definition_hash === effectDefinitionHash && claim.step_key === 'write-summary') {
      result = await executeEffect(pool, claim, execution.signal);
    } else result = await executeDeterministic(claim, execution.signal);
  }
  catch (error) { failed = true; failure = error; }
  finally { heartbeat.abort(); await renewal; }
  if (!lost) {
    if (failure instanceof LostEffectOwnership || failure instanceof EffectInfrastructureError || failure instanceof LostAgentOwnership || failure instanceof AgentInfrastructureError) return true;
    if (failed) await failStep(pool, claim, failure instanceof RetryableStepError || failure instanceof EffectUncertainError || failure instanceof ModelUnavailable);
    else await completeStep(pool, claim, result);
  }
  return true;
}
