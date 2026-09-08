import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import { createRun, getRun, IdempotencyConflict } from './application/runs.js';
import { createRunSchema } from './domain/workflow.js';
import type { CreateRunRequest } from './domain/workflow.js';
import { decideApproval, cancelRun } from './application/approvals.js';
import type { ApprovalDecision } from './application/approvals.js';
import { ApprovalForbidden, ApprovalConflict, ApprovalNotFound } from './domain/approval.js';
import { operationalPolicy, operationalSnapshot, ready } from './operations.js';

export function buildApi(pool: pg.Pool, token: string, approverToken = '', operationsPool = pool, draining = () => false) {
  if (token.length < 32) throw new Error('OPERATOR_TOKEN requires at least 32 characters');
  if (approverToken && (approverToken.length < 32 || approverToken === token)) throw new Error('distinct APPROVER_TOKEN requires at least 32 characters');
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const expectedApprover = createHash('sha256').update(`Bearer ${approverToken}`).digest();
  const app = Fastify({ logger: false, bodyLimit: 16384, connectionTimeout: 5000, requestTimeout: 5000,
    keepAliveTimeout: 5000, forceCloseConnections: 'idle', return503OnClosing: true,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
  let inFlight = 0;
  app.addHook('onRoute', route => {
    const handler = route.handler;
    route.handler = async function(request, reply) {
      if (route.url === '/healthz') return handler.call(this,request,reply);
      if (draining()) return reply.code(503).send({ error: 'draining' });
      if (inFlight >= operationalPolicy.maxInFlight) return reply.code(503).send({ error: 'overloaded' });
      inFlight++;
      try { return await handler.call(this,request,reply); } finally { inFlight--; }
    };
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.routeOptions.url === '/healthz') return;
    if (draining()) return reply.code(503).send({ error: 'draining' });
    if (request.routeOptions.url === '/readyz') return;
    const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (request.method === 'GET' && request.routeOptions.url === '/runs/:id' && approverToken && timingSafeEqual(expectedApprover,actual)) return;
    if (request.routeOptions.url === '/runs/:id/approvals/:approvalId') {
      if (!approverToken || !timingSafeEqual(expectedApprover,actual)) return reply.code(403).send({ error: 'approval_forbidden' });
      return;
    }
    if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: 'unauthorized' });
  });
  app.get('/healthz', async () => ({ status: 'alive' }));
  app.get('/readyz', async (_request, reply) => {
    try { if (await ready(operationsPool)) return { status: 'ready' }; } catch { /* coarse dependency status only */ }
    return reply.code(503).send({ status: 'not_ready' });
  });
  app.get('/operations', async () => ({ ...await operationalSnapshot(operationsPool),
    api_in_flight: inFlight, api_pool_connections: pool.totalCount, api_pool_waiting: pool.waitingCount }));
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
  const runParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
  app.post<{ Params: { id: string; approvalId: string }; Body: ApprovalDecision }>('/runs/:id/approvals/:approvalId', {
    schema: { params: { ...runParams, required: ['id','approvalId'], properties: { ...runParams.properties, approvalId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, required: ['decision','action_fingerprint','policy_fingerprint'], properties: {
        decision: { enum: ['approve','reject'] }, action_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' }, policy_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      } } },
  }, async request => decideApproval(pool,{ role: 'human-approver', id: 'local-approver' },request.params.id,request.params.approvalId,request.body));
  app.post<{ Params: { id: string } }>('/runs/:id/cancel', { schema: { params: runParams,
    body: { type: 'object', additionalProperties: false, maxProperties: 0 } } },
  async request => cancelRun(pool,{ role: 'operator', id: 'local-operator' },request.params.id));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApprovalForbidden) return reply.code(403).send({ error: 'approval_forbidden' });
    if (error instanceof ApprovalNotFound) return reply.code(404).send({ error: 'approval_or_run_not_found' });
    if (error instanceof ApprovalConflict) return reply.code(409).send({ error: 'approval_or_state_conflict' });
    if (error instanceof IdempotencyConflict) return reply.code(409).send({ error: 'idempotency_conflict' });
    const e = error as { validation?: unknown; statusCode?: number };
    if (e.validation || e.statusCode === 400) return reply.code(400).send({ error: 'invalid_request' });
    if (e.statusCode === 413 || e.statusCode === 415) return reply.code(e.statusCode).send({ error: 'invalid_payload' });
    console.error(JSON.stringify({ event: 'request-failed' }));
    return reply.code(503).send({ error: 'temporarily_unavailable' });
  });
  return app;
}
