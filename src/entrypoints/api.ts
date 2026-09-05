import { databaseUrl, port } from '../config.js';
import { createPool } from '../persistence/database.js';
import { buildApi } from '../http.js';

const pool = createPool(databaseUrl());
try {
  const app = buildApi(pool, process.env['OPERATOR_TOKEN'] ?? '', process.env['APPROVER_TOKEN'] ?? '');
  await pool.query('SELECT id FROM workflow_runs LIMIT 0');
  const url = await app.listen({ port: port(), host: '127.0.0.1' });
  console.log(JSON.stringify({ event: 'listening', url, pid: process.pid }));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close(); await pool.end();
  };
  process.on('SIGTERM', () => { void close(); });
  process.on('SIGINT', () => { void close(); });
} catch {
  console.error('API startup failed; check configuration, database and migrations');
  await pool.end(); process.exitCode = 1;
}
