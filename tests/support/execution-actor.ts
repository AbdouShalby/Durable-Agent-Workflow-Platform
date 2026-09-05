// Test-only IPC driver: production CLI has no fault injection or pause controls.
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/persistence/database.js';
import { claimStep, completeStep, failStep, recoverOne, renewLease } from '../../src/application/execution.js';
import type { Claim } from '../../src/application/execution.js';
import { executeDeterministic, RetryableStepError, runOne } from '../../src/application/worker.js';
import { databaseUrl } from '../../src/config.js';

const pool = createPool(databaseUrl(), 'daw-execution-actor');
const owner = randomUUID();
let claim: Claim | null = null;
let release: (() => void) | undefined;
process.on('message', (message: { id: string; action: string; result?: unknown; retryable?: boolean }) => {
  void (async () => {
    let value: unknown;
    switch (message.action) {
      case 'claim': claim = await claimStep(pool, owner); value = claim; break;
      case 'complete': if (!claim) throw new Error('no claim'); value = await completeStep(pool, claim, message.result); break;
      case 'fail': if (!claim) throw new Error('no claim'); value = await failStep(pool, claim, message.retryable ?? true); break;
      case 'renew': if (!claim) throw new Error('no claim'); value = await renewLease(pool, claim); break;
      case 'recover': value = await recoverOne(pool); break;
      case 'retry': value = await runOne(pool, owner, async () => { throw new RetryableStepError(); }); break;
      case 'hold': value = await runOne(pool, owner, async current => {
        await new Promise<void>(resolve => { release = resolve; process.send?.({ held: current }); });
        return executeDeterministic(current, new AbortController().signal);
      }); break;
      case 'release': release?.(); value = true; break;
      default: throw new Error('unknown test action');
    }
    process.send?.({ id: message.id, value });
  })().catch(error => process.send?.({ id: message.id, error: String(error) }));
});
process.once('SIGTERM', () => { release?.(); void pool.end().then(() => process.exit(0)); });
process.send?.({ ready: true, pid: process.pid });
