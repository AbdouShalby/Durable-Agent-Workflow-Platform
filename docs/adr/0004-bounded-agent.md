# Engine-owned bounded agent checkpoints

Status: accepted for DAW-4 on 2026-09-06, based on DAW-0 and baseline `79dbdbb`. See [validation and sign-off](../daw-4.md#review-and-evidence).

Add opt-in incident-triage v3; preserve v1/v2 definitions and fingerprints. Its final analyze-incident step uses the existing claim/lease/fence/deadline protocol. The model receives JSON data, not database handles, execution capabilities or policy controls. No approvals or writes are added.

Persist a session with fixed policy and adapter identity at admission. Reserve each model call and its estimated cost before calling; never refund a lost response. Persist each validated accepted decision before dispatching its registered read-only tool. Persist the tool observation separately. Resume accepted decisions/observations instead of regenerating them. A call lost before acceptance can recur only within the durable call/cost/attempt/deadline budgets; provider billing and model reproducibility are not guaranteed.

Use strict JSON Schema plus separate policy/registry/input/reference checks. A finish proposal does not itself complete work: engine completion must match a persisted accepted final decision. All journal/checkpoint writes use existing run-then-step locks and database-time ownership checks. Do not span a database transaction over an LLM request.

The default deterministic adapter is an explicit simulator, not a hidden fallback after real-provider failure. One opt-in OpenAI Responses adapter uses a fixed endpoint/model, bounded request/response sizes, no redirects, retries or hosted tools. It has no database dependency. Its HTTP contract is tested offline; live credentials, paid requests and AI quality claims are not required or implied.

Acceptance: real PostgreSQL/worker failures must prove checkpoint reuse, stale-owner rejection, atomic admission/checkpoints, bounded turns/calls/tool executions/estimated cost/time, strict invalid-output rejection and read-only allowlisting. Negative controls must detect disabled schema validation, allowlisting, checkpoint reuse and budgets. Preserve all earlier positive and mutation tests. Review and evidence precede the single DAW-4 commit.
