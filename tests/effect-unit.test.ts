import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { effectKey, effectFingerprint, validReceipt } from '../src/domain/effect.js';
import { fingerprint } from '../src/domain/workflow.js';
test('effect identity is logical and receipts bind service key request and result', () => {
  const run = randomUUID(), request = { summary: 'representative incident' };
  const expected = { effect_key: effectKey(run), service_id: randomUUID(), request, request_fingerprint: effectFingerprint(request) };
  const receipt = { serviceId: expected.service_id, effectKey: expected.effect_key, requestFingerprint: expected.request_fingerprint,
    receiptId: randomUUID(), result: { accepted: true, summary: request.summary } };
  assert.equal(effectKey(run), expected.effect_key); assert.notEqual(effectKey(randomUUID()), expected.effect_key);
  assert.equal(validReceipt(receipt, expected), true);
  for (const bad of [null, {}, { ...receipt, serviceId: randomUUID() }, { ...receipt, effectKey: effectKey(randomUUID()) },
    { ...receipt, requestFingerprint: effectFingerprint({ summary: 'different' }) }, { ...receipt, receiptId: 'invalid' },
    { ...receipt, result: { accepted: false, summary: request.summary } }, { ...receipt, result: { accepted: true, summary: 'different' } }]) {
    assert.equal(validReceipt(bad, expected), false);
  }
  const admission = { workflow: 'incident-triage', version: 2, input: { title: 'a', severity: 'low' }, toolContract: 'keyed' } as const;
  assert.notEqual(fingerprint(admission), fingerprint({ ...admission, toolContract: 'unkeyed' }));
});
