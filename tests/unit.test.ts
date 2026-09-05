import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRequest, fingerprint, normalizeIncident, summarizeIncident, definition } from '../src/domain/workflow.js';
import type { CreateRunRequest } from '../src/domain/workflow.js';
import { databaseUrl, port } from '../src/config.js';
const request: CreateRunRequest = { workflow: 'incident-triage', version: 1, input: { title: '  بلاغ Café  ', severity: 'high' } };
test('canonical request ignores object-key order but preserves intended parameter values', () => {
  const reordered: CreateRunRequest = { input: { severity: 'high', title: request.input.title }, version: 1, workflow: 'incident-triage' };
  assert.equal(fingerprint(request), fingerprint(reordered));
  assert.notEqual(fingerprint(request), fingerprint({ ...request, input: { ...request.input, severity: 'low' } }));
  assert.notEqual(fingerprint(request), fingerprint({ ...request, input: { ...request.input, title: request.input.title.trim() } }));
  assert.equal(JSON.parse(canonicalRequest(request)).input.title, request.input.title);
});
test('versioned deterministic steps are pure and initial scheduling is explicit', () => {
  const before = structuredClone(request.input);
  const normalized = normalizeIncident(request.input);
  assert.equal(summarizeIncident(normalized), '[HIGH] بلاغ Café');
  assert.deepEqual(request.input, before);
  assert.deepEqual(normalizeIncident(request.input), normalized);
  assert.deepEqual(definition.steps.map(s => s.state), ['READY', 'BLOCKED']);
});
test('configuration rejects malformed URLs without exposing credentials and validates ports', () => {
  const savedUrl = process.env['DATABASE_URL'], savedPort = process.env['PORT'];
  try {
    process.env['DATABASE_URL'] = 'postgresql://user:private-sentinel@[';
    assert.throws(databaseUrl, { message: 'DATABASE_URL must be a valid PostgreSQL URL' });
    process.env['PORT'] = '1e3'; assert.throws(port);
    process.env['PORT'] = '65536'; assert.throws(port);
    process.env['PORT'] = '0'; assert.equal(port(), 0);
  } finally {
    if (savedUrl === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = savedUrl;
    if (savedPort === undefined) delete process.env['PORT']; else process.env['PORT'] = savedPort;
  }
});
