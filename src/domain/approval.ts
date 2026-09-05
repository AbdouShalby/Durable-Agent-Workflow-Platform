import { createHash } from 'node:crypto';
export const approvalPolicy = Object.freeze({ version: 'summary-review-v1', highSeverityRequiresHuman: true, ttlMs: 300000 });
export const policyFingerprint = createHash('sha256').update(JSON.stringify(approvalPolicy)).digest('hex');
export interface Principal { role: 'operator' | 'human-approver' | 'agent'; id: string }
export class ApprovalForbidden extends Error {}
export class ApprovalConflict extends Error {}
export class ApprovalNotFound extends Error {}
export function requireHuman(principal: Principal): void {
  if (principal.role !== 'human-approver' || principal.id !== 'local-approver') throw new ApprovalForbidden();
}
export interface Action {
  run_id: string; step_key: string; effect_key: string; contract: string; service_id: string; service_url: string;
  request: { summary: string }; request_fingerprint: string;
}
export function actionFingerprint(action: Action, policy: { policy_version: string; policy_fingerprint: string }): string {
  return createHash('sha256').update(JSON.stringify({ run: action.run_id, step: action.step_key, tool: 'write-summary',
    effectKey: action.effect_key, contract: action.contract, serviceId: action.service_id, serviceUrl: action.service_url,
    request: { summary: action.request.summary }, requestFingerprint: action.request_fingerprint,
    policyVersion: policy.policy_version, policyFingerprint: policy.policy_fingerprint })).digest('hex');
}
