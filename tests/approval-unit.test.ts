import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actionFingerprint, policyFingerprint, approvalPolicy, requireHuman, ApprovalForbidden } from '../src/domain/approval.js';
import { effectKey, effectFingerprint } from '../src/domain/effect.js';
import { acceptDecision, AgentPolicyError } from '../src/domain/agent.js';

test('approval fingerprint binds identity target tool parameters and policy', () => {
  const run = randomUUID(), payload = { summary: 'Synthetic action' };
  const action = { run_id: run, step_key: 'write-summary', effect_key: effectKey(run,4), contract: 'keyed', service_id: randomUUID(),
    service_url: 'http://127.0.0.1:1234', request: payload, request_fingerprint: effectFingerprint(payload) };
  const policy = { policy_version: approvalPolicy.version, policy_fingerprint: policyFingerprint };
  const original = actionFingerprint(action,policy);
  assert.equal(actionFingerprint(structuredClone(action),policy), original);
  for (const change of [{ run_id: randomUUID() },{ step_key: 'other' },{ effect_key: effectKey(randomUUID(),4) },{ contract: 'unkeyed' },
    { service_id: randomUUID() },{ service_url: 'http://127.0.0.1:4321' },{ request: { summary: 'Changed' } },{ request_fingerprint: '0'.repeat(64) }]) {
    assert.notEqual(actionFingerprint({ ...action,...change },policy),original);
  }
  assert.notEqual(actionFingerprint(action,{ ...policy,policy_version:'other' }),original);
  assert.notEqual(actionFingerprint(action,{ ...policy,policy_fingerprint:'0'.repeat(64) }),original);
});
test('engine approval principal excludes operators and agents', () => {
  for (const role of ['agent','operator'] as const) assert.throws(() => requireHuman({ role,id:'local-approver' }),ApprovalForbidden);
  assert.throws(() => requireHuman({ role:'human-approver',id:'invented' }),ApprovalForbidden);
  requireHuman({ role:'human-approver',id:'local-approver' });
});
test('agent output cannot express approval cancellation policy or write capabilities', () => {
  const read = { kind:'read',tool:'incident-context',arguments:{ topic:'summary' },summary:null,evidence:[] };
  for (const field of ['approval','approved','policy','expires_at','principal','cancel']) {
    assert.throws(() => acceptDecision(JSON.stringify({ ...read,[field]:true }),[]),AgentPolicyError);
  }
  for (const tool of ['approve','cancel','write-summary','sql']) assert.throws(() => acceptDecision(JSON.stringify({ ...read,tool }),[]),AgentPolicyError);
});
