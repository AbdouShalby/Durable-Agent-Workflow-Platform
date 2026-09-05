import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import { createRun, getRun, IdempotencyConflict } from './application/runs.js';
import { createRunSchema } from './domain/workflow.js';
import type { CreateRunRequest } from './domain/workflow.js';

export function buildApi(pool: pg.Pool, token: string) {
  if (token.length < 32) throw new Error('OPERATOR_TOKEN requires at least 32 characters');
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const app = Fastify({ logger: false, bodyLimit: 16384,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.routeOptions.url === '/healthz') return;
    const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.get('/healthz', async () => ({ status: 'alive' }));
  app.post<{ Body: CreateRunRequest; Headers: { 'idempotency-key': string } }>('/runs', {
    schema: { body: createRunSchema, headers: { type: 'object', required: ['idempotency-key'],
      properties: { 'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' } } } },
  }, async (request, reply) => {
    const result = await createRun(pool, 'local-operator', request.headers['idempotency-key'], request.body);
    return reply.code(result.created ? 202 : 200).header('Location', `/runs/${result.run.id}`).send({
      run_id: result.run.id, state: result.run.state, replayed: !result.created,
    });
  });
  app.get<{ Params: { id: string } }>('/runs/:id', { schema: { params: { type: 'object', required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => {
    const run = await getRun(pool, 'local-operator', request.params.id);
    return run === null ? reply.code(404).send({ error: 'run_not_found' }) : run;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof IdempotencyConflict) return reply.code(409).send({ error: 'idempotency_conflict' });
    const e = error as { validation?: unknown; statusCode?: number };
    if (e.validation || e.statusCode === 400) return reply.code(400).send({ error: 'invalid_request' });
    if (e.statusCode === 413 || e.statusCode === 415) return reply.code(e.statusCode).send({ error: 'invalid_payload' });
    console.error(JSON.stringify({ event: 'request-failed' }));
    return reply.code(503).send({ error: 'temporarily_unavailable' });
  });
  return app;
}
