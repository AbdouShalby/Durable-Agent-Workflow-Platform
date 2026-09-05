// Test-only IPC timing control around production functions; no fake transport or database.
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/persistence/database.js';
import { databaseUrl } from '../../src/config.js';
import { claimStep, completeStep } from '../../src/application/execution.js';
import type { Claim } from '../../src/application/execution.js';
import { runOne } from '../../src/application/worker.js';
import { executeEffect, saveReceipt } from '../../src/application/effects.js';
const pool = createPool(databaseUrl(), 'daw-effect-actor'), owner = randomUUID();
let claim: Claim | null = null;
process.on('message', (message: { id: string; action: string; receipt?: unknown }) => {
  void (async () => {
    let value: unknown;
    switch (message.action) {
      case 'claim': claim = await claimStep(pool, owner); value = claim; break;
      case 'run': value = await runOne(pool, owner); break;
      case 'execute': if (!claim) throw new Error('missing claim'); value = await executeEffect(pool, claim, new AbortController().signal); break;
      case 'save': if (!claim) throw new Error('missing claim'); value = await saveReceipt(pool, claim, message.receipt); break;
      case 'complete': if (!claim) throw new Error('missing claim'); value = await completeStep(pool, claim, message.receipt); break;
      default: throw new Error('unknown action');
    }
    process.send?.({ id: message.id, value });
  })().catch(() => process.send?.({ id: message.id, error: true }));
});
process.once('SIGTERM', () => { void pool.end().then(() => process.exit(0)); });
process.send?.({ ready: true, pid: process.pid });
