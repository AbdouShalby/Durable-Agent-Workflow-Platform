import type pg from 'pg';
import { transaction, lockStep, owns, event } from './execution.js';
import type { Claim } from './execution.js';
import { effectKey, effectFingerprint, validReceipt } from '../domain/effect.js';
import type { EffectContract, EffectRequest, Receipt } from '../domain/effect.js';
import { guardEffectApproval } from './approvals.js';

interface Invocation {
  effect_key: string; contract: EffectContract; service_id: string; service_url: string;
  request: EffectRequest; request_fingerprint: string; state: 'PREPARED' | 'UNKNOWN' | 'VERIFIED'; receipt: Receipt | null;
}
export class EffectUncertainError extends Error {}
export class LostEffectOwnership extends Error {}
export class EffectInfrastructureError extends Error {}
class InvalidEffectIntent extends Error {}
async function infrastructure<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof InvalidEffectIntent || error instanceof LostEffectOwnership) throw error;
    // An uncertain platform COMMIT is not a permanent executor failure. Leave the lease for recovery.
    throw new EffectInfrastructureError();
  }
}
const read = async (client: pg.PoolClient, claim: Claim): Promise<Invocation> => {
  const row = (await client.query<Invocation>('SELECT * FROM tool_invocations WHERE run_id=$1 AND step_key=$2', [claim.run_id,claim.step_key])).rows[0];
  const previous = claim.workflow_version === 4 ? (claim.previous_result as { summary?: unknown } | null)?.summary : claim.previous_result;
  if (!row || row.effect_key !== effectKey(claim.run_id,claim.workflow_version) || row.request_fingerprint !== effectFingerprint(row.request) ||
      row.request.summary !== previous) throw new InvalidEffectIntent('invalid durable effect intent');
  return row;
};

/** Only a fresh owner may persist a verified receipt. No transaction spans HTTP. */
export async function saveReceipt(pool: pg.Pool, claim: Claim, receipt: unknown): Promise<boolean> {
  return infrastructure(() => transaction(pool, async client => {
    await lockStep(client, claim.run_id, claim.step_key);
    if (!await owns(client, claim)) return false;
    if (!await guardEffectApproval(client,claim,'verify')) return false;
    const row = await read(client, claim);
    if (row.state === 'PREPARED' || !validReceipt(receipt, row)) return false;
    if (row.state === 'VERIFIED') return true;
    await client.query(`UPDATE tool_invocations SET state='VERIFIED',receipt=$3,updated_at=clock_timestamp()
      WHERE run_id=$1 AND step_key=$2`, [claim.run_id,claim.step_key,JSON.stringify(receipt)]);
    await event(client, claim.run_id, 'EFFECT_VERIFIED', { step: claim.step_key, effect_key: row.effect_key, receipt_id: receipt.receiptId });
    return true;
  }));
}

export async function executeEffect(pool: pg.Pool, claim: Claim, signal: AbortSignal): Promise<Receipt> {
  const prepared = await infrastructure(() => transaction(pool, async client => {
    await lockStep(client, claim.run_id, claim.step_key);
    if (!await owns(client, claim)) throw new LostEffectOwnership();
    const persisted = (await client.query('SELECT state FROM tool_invocations WHERE run_id=$1 AND step_key=$2', [claim.run_id,claim.step_key])).rows[0];
    if (!await guardEffectApproval(client,claim,persisted?.state === 'PREPARED' ? 'prepare':'verify')) return null;
    const row = await read(client, claim);
    if (row.state === 'VERIFIED') return { row, first: false };
    const first = row.state === 'PREPARED';
    // Intent is UNKNOWN durably BEFORE a request can leave this process, including a crash before send.
    if (first) {
      await client.query(`UPDATE tool_invocations SET state='UNKNOWN',updated_at=clock_timestamp()
        WHERE run_id=$1 AND step_key=$2`, [claim.run_id,claim.step_key]);
      await event(client, claim.run_id, 'EFFECT_UNKNOWN', { step: claim.step_key, effect_key: row.effect_key });
    }
    return { row, first };
  }));
  if (!prepared) throw new LostEffectOwnership();
  const row = prepared.row;
  if (row.state === 'VERIFIED' && row.receipt) return row.receipt;
  const request = async (method: 'GET' | 'POST'): Promise<Response> => {
    // A bounded request only bounds client waiting; abort never proves server rollback.
    return fetch(`${row.service_url}/effects/${row.contract}${method === 'GET' ? '/' + row.effect_key : ''}`, {
      method, signal: AbortSignal.any([signal, AbortSignal.timeout(700)]), redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Service-Id': row.service_id },
      ...(method === 'POST' ? { body: JSON.stringify({ effectKey: row.effect_key, request: row.request, requestFingerprint: row.request_fingerprint }) } : {}),
    });
  };
  const count = async (kind: 'sends' | 'verifications'): Promise<void> => {
    const allowed = await infrastructure(() => transaction(pool, async client => {
    await lockStep(client, claim.run_id, claim.step_key);
    if (!await owns(client, claim)) throw new LostEffectOwnership();
    if (!await guardEffectApproval(client,claim,kind === 'sends' ? 'send':'verify')) return false;
    await client.query(`UPDATE tool_invocations SET ${kind}=${kind}+1,updated_at=clock_timestamp() WHERE run_id=$1 AND step_key=$2`, [claim.run_id,claim.step_key]);
    return true;
    }));
    if (!allowed) throw new LostEffectOwnership();
  };
  try {
    let receipt: unknown;
    if (!prepared.first) {
      if (row.contract !== 'keyed') throw new EffectUncertainError();
      await count('verifications');
      const verified = await request('GET');
      if (verified.status === 200) receipt = await verified.json();
      // Not found is NOT proof of non-execution: only a reliable key contract permits a resend.
      else if (verified.status !== 404) throw new EffectUncertainError();
    }
    if (receipt === undefined) {
      await count('sends');
      const response = await request('POST');
      if (!response.ok) throw new EffectUncertainError();
      receipt = await response.json();
    }
    if (!validReceipt(receipt, row)) throw new EffectUncertainError();
    if (!await saveReceipt(pool, claim, receipt)) throw new LostEffectOwnership();
    return receipt;
  } catch (error) {
    if (error instanceof LostEffectOwnership || error instanceof EffectInfrastructureError || error instanceof InvalidEffectIntent) throw error;
    // Invalid receipts, transport errors and timeout leave the external outcome uncertain.
    throw new EffectUncertainError();
  }
}
