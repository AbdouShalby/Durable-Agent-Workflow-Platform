import { createHash } from 'node:crypto';

export interface IncidentInput { title: string; severity: 'low' | 'high' }
export interface CreateRunRequest { workflow: 'incident-triage'; version: 1; input: IncidentInput }

export const definition = Object.freeze({
  name: 'incident-triage', version: 1,
  steps: Object.freeze([
    Object.freeze({ key: 'normalize-incident', ordinal: 0, state: 'READY' }),
    Object.freeze({ key: 'build-summary', ordinal: 1, state: 'BLOCKED' }),
  ]),
});

// DAW-2 executes these pure steps; the definition and its v1 hash remain unchanged.
export function normalizeIncident(input: IncidentInput): IncidentInput {
  return { title: input.title.trim(), severity: input.severity };
}
export function summarizeIncident(input: IncidentInput): string {
  return `[${input.severity.toUpperCase()}] ${input.title}`;
}

// Explicit field order avoids key-order dependence. Values are NOT trimmed or coerced.
// The HTTP schema rejects unsupported fields before this canonicalization.
export function canonicalRequest(request: CreateRunRequest): string {
  return JSON.stringify({ workflow: request.workflow, version: request.version,
    input: { title: request.input.title, severity: request.input.severity } });
}
export function fingerprint(request: CreateRunRequest): string {
  return createHash('sha256').update(canonicalRequest(request)).digest('hex');
}
export const definitionHash = createHash('sha256').update(JSON.stringify(definition)).digest('hex');

export const createRunSchema = {
  type: 'object', additionalProperties: false, required: ['workflow', 'version', 'input'],
  properties: {
    workflow: { const: 'incident-triage' }, version: { type: 'integer', const: 1 },
    input: {
      type: 'object', additionalProperties: false, required: ['title', 'severity'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        severity: { type: 'string', enum: ['low', 'high'] },
      },
    },
  },
} as const;
