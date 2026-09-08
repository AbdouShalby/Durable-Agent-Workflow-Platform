# Operational signals without a new orchestration layer

Status: accepted for DAW-6 local showcase sign-off, 2026-09-08. Baseline `7c3146a` and approved DAW-0 are authoritative. See the final gate and limitations in [DAW-6](../daw-6.md).

Reuse PostgreSQL journals and existing process roles. Readiness compares this checkout's migration identity and readable capabilities without migrating. A separate small probe pool isolates telemetry from the primary pool; API handler admission still rejects overload. Fixed aggregate names prevent run/owner/effect IDs becoming metric labels. Structured attempt spans correlate retries using the run identity and per-attempt fence; they are local JSON logs, not an OpenTelemetry backend or propagated distributed trace.

Shutdown stops admitting/polling, drains current work, then uses a five-second event-loop timer for nonzero exit. Do not abort a possible external write and call it rolled back. Existing leases, fencing, UNKNOWN verification and approval/cancellation rules remain the authority. An outer OS supervisor would be needed to preempt event-loop blockage; not added here.

Real outage tests exposed a pre-existing unhandled checked-out PostgreSQL Client error. Register a fixed-message listener per connected client, retaining query rejection and retry/reconciliation semantics. Do not swallow a failed query or return a fictitious committed result.

No new migration, workflow version, external tool, dependency, broker, collector or dashboard. Five operational mutations and the full previous suite are required. See [runbook](../runbooks/operations.md) for precise signal definitions, overload/query cost limits and failure response.

Primary references: [Fastify shutdown lifecycle](https://fastify.dev/docs/latest/Reference/Server/), [node-postgres pool lifecycle](https://node-postgres.com/apis/pool). Installed-library source and repository tests determine the demonstrated behavior; library documentation alone is not implementation evidence.
