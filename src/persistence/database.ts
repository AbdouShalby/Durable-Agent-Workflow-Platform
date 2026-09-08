import pg from 'pg';

export function createPool(connectionString: string, applicationName = 'daw-api'): pg.Pool {
  const pool = new pg.Pool({ connectionString, application_name: applicationName,
    max: 16, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
    statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 });
  // Do not log SQL, connection URLs, credentials or request contents.
  pool.on('error', () => console.error(JSON.stringify({ event: 'database-pool-error' })));
  // Checked-out clients can emit separately from idle pool errors. Queries still reject;
  // only the unhandled EventEmitter crash is prevented, never a successful DB result invented.
  pool.on('connect', client => client.on('error', () => console.error(JSON.stringify({ event: 'database-client-error' }))));
  return pool;
}
