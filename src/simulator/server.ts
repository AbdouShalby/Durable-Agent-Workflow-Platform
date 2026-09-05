// Independent HTTP service: its own PostgreSQL URL/schema/transactions. No platform imports.
import Fastify from 'fastify';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
const url = process.env['SIMULATOR_DATABASE_URL'], serviceId = process.env['SIMULATOR_SERVICE_ID'];
if (!url || !serviceId || !/^[a-f0-9-]{36}$/.test(serviceId)) throw new Error('simulator database and stable identity required');
const mode = process.env['SIMULATOR_FAULT'] ?? 'normal';
if (!['normal','hold-response','bad-receipt','lookup-unavailable','reject-before-write'].includes(mode)) throw new Error('unknown simulator fault');
const pool = new pg.Pool({ connectionString: url, application_name: 'daw-independent-simulator', max: 12 });
const app = Fastify({ logger: false, bodyLimit: 4096 });
await pool.query(`CREATE TABLE IF NOT EXISTS simulator_identity (singleton boolean PRIMARY KEY CHECK(singleton),id uuid NOT NULL);
  CREATE TABLE IF NOT EXISTS external_writes (id uuid PRIMARY KEY,effect_key text UNIQUE,fingerprint text NOT NULL,receipt jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS external_requests (id bigserial PRIMARY KEY,effect_key text NOT NULL,method text NOT NULL);`);
await pool.query('INSERT INTO simulator_identity VALUES(true,$1) ON CONFLICT DO NOTHING', [serviceId]);
if ((await pool.query('SELECT id FROM simulator_identity')).rows[0]?.id !== serviceId) throw new Error('simulator identity does not match persisted store');
app.addHook('onRequest', async (request, reply) => {
  if (request.headers['x-service-id'] !== serviceId) return reply.code(409).send({ error: 'wrong_service' });
});
app.get<{ Params: { key: string } }>('/effects/keyed/:key', async (request, reply) => {
  await pool.query("INSERT INTO external_requests(effect_key,method) VALUES($1,'GET')", [request.params.key]);
  if (mode === 'lookup-unavailable') return reply.code(503).send({ error: 'unavailable' });
  const found = (await pool.query('SELECT receipt FROM external_writes WHERE effect_key=$1', [request.params.key])).rows[0];
  return found ? reply.send(found.receipt) : reply.code(404).send({ error: 'not_found' });
});
interface Body { effectKey: string; requestFingerprint: string; request: { summary: string } }
app.post<{ Body: Body; Params: { contract: string } }>('/effects/:contract', { schema: { body: {
  type: 'object', additionalProperties: false, required: ['effectKey','requestFingerprint','request'], properties: {
    effectKey: { type: 'string', pattern: '^[a-f0-9]{64}$' }, requestFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    request: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string', maxLength: 300 } } },
  },
} } }, async (request, reply) => {
  const contract = request.params.contract;
  if (contract !== 'keyed' && contract !== 'unkeyed') return reply.code(404).send();
  const body = request.body;
  const fingerprint = createHash('sha256').update(JSON.stringify({ summary: body.request.summary })).digest('hex');
  if (fingerprint !== body.requestFingerprint) return reply.code(409).send({ error: 'fingerprint' });
  await pool.query("INSERT INTO external_requests(effect_key,method) VALUES($1,'POST')", [body.effectKey]);
  if (mode === 'reject-before-write') return reply.code(503).send({ error: 'unavailable' });
  const client = await pool.connect();
  let receipt: unknown;
  try {
    await client.query('BEGIN');
    const id = randomUUID();
    const proposed = { serviceId, effectKey: body.effectKey, requestFingerprint: fingerprint, receiptId: id,
      result: { accepted: true, summary: body.request.summary } };
    const key = contract === 'keyed' ? body.effectKey : null;
    const inserted = await client.query(`INSERT INTO external_writes(id,effect_key,fingerprint,receipt) VALUES($1,$2,$3,$4)
      ON CONFLICT(effect_key) DO NOTHING RETURNING receipt`, [id,key,fingerprint,proposed]);
    const winner = inserted.rows[0] ?? (await client.query('SELECT receipt,fingerprint FROM external_writes WHERE effect_key=$1', [key])).rows[0];
    if (!winner || (winner.fingerprint && winner.fingerprint !== fingerprint)) {
      await client.query('ROLLBACK'); return reply.code(409).send({ error: 'effect_key_conflict' });
    }
    receipt = winner.receipt; await client.query('COMMIT');
  } catch { await client.query('ROLLBACK'); return reply.code(503).send({ error: 'storage' }); }
  finally { client.release(); }
  if (mode === 'hold-response') { reply.hijack(); return; } // Commit happened; client must time out or crash.
  if (mode === 'bad-receipt') return reply.send({ ...receipt as object, effectKey: 'wrong' });
  return reply.send(receipt);
});
app.setErrorHandler((_error, _request, reply) => { void reply.code(400).send({ error: 'invalid_request' }); });
const address = await app.listen({ host: '127.0.0.1', port: Number(process.env['SIMULATOR_PORT'] ?? 0) });
console.log(JSON.stringify({ event: 'simulator_listening', url: address, pid: process.pid }));
const stop = () => { app.server.closeAllConnections(); void app.close().then(() => pool.end()).then(() => process.exit(0)); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
