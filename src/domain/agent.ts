import { Ajv } from 'ajv';
import type { IncidentInput } from './workflow.js';

export const agentPolicy = Object.freeze({ maxTurns: 4, maxCalls: 5, maxToolCalls: 3,
  maxCostMicros: 40000, callCostMicros: 10000, maxElapsedMs: 30000, callTimeoutMs: 5000 });
export const modelSnapshot = 'gpt-4.1-mini-2025-04-14';
export class AgentPolicyError extends Error {}
export class AgentBudgetError extends AgentPolicyError {}
export interface AgentDecision {
  kind: 'read' | 'finish'; tool: string | null; arguments: { topic: string } | null;
  summary: string | null; evidence: string[];
}
export interface Observation { id: string; data: { text: string } }
export interface Checkpoint { turn: number; decision: AgentDecision; observation: Observation | null }
export interface AgentContext { incident: IncidentInput; checkpoints: Checkpoint[] }

export const decisionSchema = {
  type: 'object', additionalProperties: false, required: ['kind','tool','arguments','summary','evidence'],
  properties: {
    kind: { type: 'string', enum: ['read','finish'] },
    tool: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
    arguments: { anyOf: [{ type: 'object', additionalProperties: false, required: ['topic'],
      properties: { topic: { type: 'string', maxLength: 32 } } }, { type: 'null' }] },
    summary: { anyOf: [{ type: 'string', minLength: 1, maxLength: 1000 }, { type: 'null' }] },
    evidence: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 100 } },
  },
} as const;
const ajv = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
const validateDecision = ajv.compile<AgentDecision>(decisionSchema);
const registry = new Map([
  ['incident-context', { access: 'read-only', validate: ajv.compile({ type: 'object', additionalProperties: false,
    required: ['topic'], properties: { topic: { const: 'summary' } } }),
  read: (incident: IncidentInput) => ({ text: `[${incident.severity.toUpperCase()}] ${incident.title.trim()}` }) }],
  ['runbook', { access: 'read-only', validate: ajv.compile({ type: 'object', additionalProperties: false,
    required: ['topic'], properties: { topic: { const: 'guidance' } } }),
  read: (incident: IncidentInput) => ({ text: incident.severity === 'high' ? 'Investigate the synthetic incident promptly.' : 'Review the synthetic incident during routine triage.' }) }],
]);

export function validateTool(name: string | null, args: unknown): void {
  const entry = name === null ? undefined : registry.get(name);
  if (!entry || entry.access !== 'read-only') throw new AgentPolicyError('unregistered read-only tool');
  if (!entry.validate(args)) throw new AgentPolicyError('invalid tool input');
}
export function acceptDecision(raw: string, history: Checkpoint[]): AgentDecision {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw new AgentPolicyError('invalid model output size');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AgentPolicyError('invalid model JSON'); }
  if (!validateDecision(value)) throw new AgentPolicyError('invalid model output schema');
  const decision = value as AgentDecision;
  if (decision.kind === 'read') {
    validateTool(decision.tool, decision.arguments);
    if (decision.summary !== null || decision.evidence.length !== 0) throw new AgentPolicyError('invalid read proposal');
  } else {
    const available = new Set(history.flatMap(c => c.observation ? [c.observation.id] : []));
    if (decision.tool !== null || decision.arguments !== null || !decision.summary?.trim() ||
        decision.evidence.length === 0 || new Set(decision.evidence).size !== decision.evidence.length ||
        decision.evidence.some(id => !available.has(id))) throw new AgentPolicyError('invalid finish proposal');
  }
  return decision;
}
export function readTool(decision: AgentDecision, incident: IncidentInput, turn: number): Observation {
  validateTool(decision.tool, decision.arguments);
  const entry = registry.get(decision.tool!);
  if (!entry) throw new AgentPolicyError('tool missing');
  return { id: `turn:${turn}:${decision.tool}`, data: entry.read(incident) };
}
export function finalAgentResult(decision: AgentDecision): unknown {
  return { summary: decision.summary, evidence: decision.evidence };
}
