import { createHash } from 'node:crypto';
export type EffectContract = 'keyed' | 'unkeyed';
export interface EffectRequest { summary: string }
export interface Receipt {
  serviceId: string; effectKey: string; requestFingerprint: string; receiptId: string;
  result: { accepted: true; summary: string };
}
export const effectFingerprint = (request: EffectRequest): string => createHash('sha256')
  .update(JSON.stringify({ summary: request.summary })).digest('hex');
// Logical identity, never attempt/owner/fence: a retry must address the same external operation.
export const effectKey = (run: string): string => createHash('sha256').update(`daw:incident-triage:2:${run}:write-summary`).digest('hex');
export function validReceipt(value: unknown, expected: { effect_key: string; service_id: string; request_fingerprint: string; request: EffectRequest }): value is Receipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<Receipt>;
  return r.serviceId === expected.service_id && r.effectKey === expected.effect_key &&
    r.requestFingerprint === expected.request_fingerprint && typeof r.receiptId === 'string' &&
    /^[a-f0-9-]{36}$/.test(r.receiptId) && r.result?.accepted === true && r.result.summary === expected.request.summary;
}
export function effectTarget(): { url: string; id: string } {
  const raw = process.env['EFFECT_SERVICE_URL'], id = process.env['EFFECT_SERVICE_ID'];
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw new Error('EFFECT_SERVICE_URL required'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('effect simulator requires a credential-free loopback HTTP origin');
  }
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('EFFECT_SERVICE_ID required');
  return { url: url.origin, id };
}
