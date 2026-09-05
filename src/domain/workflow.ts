import { createHash } from 'node:crypto';
import { agentPolicy } from './agent.js';
import { approvalPolicy } from './approval.js';

export interface IncidentInput { title: string; severity: 'low' | 'high' }
export type CreateRunRequest = { workflow: 'incident-triage'; version: 1; input: IncidentInput } |
  { workflow: 'incident-triage'; version: 2; input: IncidentInput; toolContract: 'keyed' | 'unkeyed' } |
  { workflow: 'incident-triage'; version: 3 | 4; input: IncidentInput };

export const definition = Object.freeze({
  name: 'incident-triage', version: 1,
  steps: Object.freeze([
    Object.freeze({ key: 'normalize-incident', ordinal: 0, state: 'READY' }),
    Object.freeze({ key: 'build-summary', ordinal: 1, state: 'BLOCKED' }),
  ]),
});

export const effectDefinition = Object.freeze({ name: 'incident-triage', version: 2,
  steps: Object.freeze([...definition.steps, Object.freeze({ key: 'write-summary', ordinal: 2, state: 'BLOCKED' })]),
});
export const effectDefinitionHash = createHash('sha256').update(JSON.stringify(effectDefinition)).digest('hex');
export const agentDefinition = Object.freeze({ name: 'incident-triage', version: 3, policy: agentPolicy,
  steps: Object.freeze([...definition.steps, Object.freeze({ key: 'analyze-incident', ordinal: 2, state: 'BLOCKED' })]),
});
export const agentDefinitionHash = createHash('sha256').update(JSON.stringify(agentDefinition)).digest('hex');
export const governedDefinition = Object.freeze({ name: 'incident-triage', version: 4, agentPolicy, approvalPolicy,
  steps: Object.freeze([...agentDefinition.steps, Object.freeze({ key: 'write-summary', ordinal: 3, state: 'BLOCKED' })]),
});
export const governedDefinitionHash = createHash('sha256').update(JSON.stringify(governedDefinition)).digest('hex');

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
    input: { title: request.input.title, severity: request.input.severity },
    ...(request.version === 2 ? { toolContract: request.toolContract } : {}) });
}
export function fingerprint(request: CreateRunRequest): string {
  return createHash('sha256').update(canonicalRequest(request)).digest('hex');
}
export const definitionHash = createHash('sha256').update(JSON.stringify(definition)).digest('hex');

const v1Schema = {
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
export const createRunSchema = { oneOf: [v1Schema, { ...v1Schema,
  required: [...v1Schema.required, 'toolContract'],
  properties: { ...v1Schema.properties, version: { type: 'integer', const: 2 },
    toolContract: { type: 'string', enum: ['keyed','unkeyed'] } },
}, { ...v1Schema, properties: { ...v1Schema.properties, version: { type: 'integer', enum: [3,4] } } }] } as const;
