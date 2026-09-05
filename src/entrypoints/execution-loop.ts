import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { databaseUrl } from '../config.js';
import { createPool } from '../persistence/database.js';
import { recoverOne } from '../application/execution.js';
import { runOne } from '../application/worker.js';

/** Local process roles share a bounded polling loop, not an in-memory queue. SIGTERM stops new polls after in-flight work. */
export async function executionLoop(role: 'worker' | 'scheduler'): Promise<void> {
  const owner = randomUUID();
  const pool = createPool(databaseUrl(), `daw-${role}`);
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try {
    await pool.query('SELECT fence FROM step_runs LIMIT 0');
    console.log(JSON.stringify({ event: 'started', role, owner, pid: process.pid }));
    while (!stop.signal.aborted) {
      let worked = false;
      try { worked = role === 'worker' ? await runOne(pool, owner) : await recoverOne(pool); }
      catch { console.error(JSON.stringify({ event: 'poll_failed', role })); }
      if (!worked && !stop.signal.aborted) {
        try { await sleep(100, undefined, { signal: stop.signal }); } catch { /* Shutdown interrupts only polling sleep. */ }
      }
    }
  } finally {
    process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
    await pool.end();
  }
}
