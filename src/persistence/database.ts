import pg from 'pg';

export function createPool(connectionString: string, applicationName = 'daw-api'): pg.Pool {
  const pool = new pg.Pool({ connectionString, application_name: applicationName,
    max: 16, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
    statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 });
  // Do not log SQL, connection URLs, credentials or request contents.
  pool.on('error', () => console.error(JSON.stringify({ event: 'database-pool-error' })));
  return pool;
}
