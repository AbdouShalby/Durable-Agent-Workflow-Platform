import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { databaseUrl } from '../config.js';
import { createPool } from '../persistence/database.js';
import { recoverOne } from '../application/execution.js';
import { runOne } from '../application/worker.js';
import { operationalPolicy, ready, shutdownControl } from '../operations.js';

/** Local process roles share a bounded polling loop, not an in-memory queue. SIGTERM stops new polls after in-flight work. */
export async function executionLoop(role: 'worker' | 'scheduler'): Promise<void> {
  const owner = randomUUID();
  const pool = createPool(databaseUrl(), `daw-${role}`);
  const stop = shutdownControl(role);
  try {
    if (!await ready(pool)) throw new Error('schema not ready');
    console.log(JSON.stringify({ event: 'started', role, owner, pid: process.pid }));
    while (!stop.signal.aborted) {
      let worked = false, failed = false;
      try { worked = role === 'worker' ? await runOne(pool, owner) : await recoverOne(pool);
        if (worked) console.log(JSON.stringify({ event: 'poll_progress', role })); }
      catch { failed = true; console.error(JSON.stringify({ event: 'poll_failed', role })); }
      if (!worked && !stop.signal.aborted) {
        try { await sleep(failed ? operationalPolicy.errorPollMs : operationalPolicy.idlePollMs, undefined, { signal: stop.signal }); } catch { /* Shutdown interrupts only polling sleep. */ }
      }
    }
  } finally {
    await pool.end();
    stop.finish();
  }
}
