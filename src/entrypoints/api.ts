import { databaseUrl, port } from '../config.js';
import { createPool } from '../persistence/database.js';
import { buildApi } from '../http.js';
import { probePool, ready, shutdownControl } from '../operations.js';

const pool = createPool(databaseUrl());
const probes = probePool(databaseUrl());
const shutdown = shutdownControl('api');
try {
  const app = buildApi(pool, process.env['OPERATOR_TOKEN'] ?? '', process.env['APPROVER_TOKEN'] ?? '', probes, () => shutdown.signal.aborted);
  if (!await ready(probes)) throw new Error('schema not ready');
  if (shutdown.signal.aborted) throw new Error('startup interrupted');
  const url = await app.listen({ port: port(), host: '127.0.0.1' });
  console.log(JSON.stringify({ event: 'listening', url, pid: process.pid }));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close(); await probes.end(); await pool.end(); shutdown.finish();
  };
  const requestClose = () => { void close().catch(() => { process.exitCode=1; }); };
  shutdown.signal.addEventListener('abort', requestClose, { once: true });
  if (shutdown.signal.aborted) requestClose();
} catch {
  console.error('API startup failed; check configuration, database and migrations');
  await probes.end(); await pool.end(); shutdown.finish(); process.exitCode = 1;
}
