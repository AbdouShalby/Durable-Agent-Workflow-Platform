# ADR 0002: PostgreSQL-leased deterministic execution

Status: accepted for DAW-2; production-inspired showcase, not production-proven infrastructure.

## Decision

Keep the existing PostgreSQL schedule. No broker or separate outbox is necessary for these database-local transitions. Claim a run with `FOR UPDATE SKIP LOCKED`, then its ready step; renew, complete, fail and reconcile always lock the run before the step. Runs progress independently; the run lock also serializes event sequence allocation. A partial unique index permits at most one `RUNNING` step per run. State predicates remain defensive checks, not pre-check-based ownership.

Claiming increments the durable attempt count and per-step fence, records the attempt, sets owner/lease/deadline, marks the run running and appends an event in one transaction. No database transaction spans execution. The shipped executor supports only the pinned incident-triage v1 pure functions and consumes saved prior results; unsupported versions/hashes/steps fail permanently.

Renewal, explicit failure and completion check current owner, fence, running state, lease and deadline **after acquiring locks**, using `clock_timestamp()`. That check is the transition's linearization point. Database commit may physically occur after lease expiry while the transaction retains its locks; recovery cannot interleave and supersede it. This is not a claim that the lease must remain valid at the instant bytes are flushed. The competing transition either linearizes first or loses current authority.

A valid completion atomically saves the result, closes the attempt, appends events and releases the next step (or completes the run). Repeating completion has no new transition. The old worker may continue computing after expiry, but its token cannot authorize a new transition. There are no external effects to fence.

## Retry and reconciliation

Policy values are persisted in each step, including for existing DAW-1 `READY`/`BLOCKED` rows through migration defaults. Migration 001 is unchanged; migration 002 extends its constraints and adds attempts. No historical executions are invented. The elapsed deadline starts on the first claim, not during queue admission, and survives retries. It is not a queue-wait SLO.

Defaults: `lease_ms=3000`, `max_attempts=3` (including the first), `retry_base_ms=200`, `retry_cap_ms=2000`, `max_elapsed_ms=30000`. The schema bounds policy ranges. Heartbeats occur every `floor(lease_ms/3)` and clamp the lease to the deadline. They cannot resurrect an expired lease.

For failed attempt `n`, the exponential ceiling is `min(cap, base * 2^(n-1))`. Equal jitter selects an integer from `ceil(ceiling/2)` through `ceiling`, seeded with SHA-256 of policy version, run ID, step key and attempt. The computed delay is recorded in the closed attempt and used once to persist `available_at`. A scheduler restart does not resample it. This is reproducible de-synchronization, not cryptographic randomness or deterministic process timing.

Only `RetryableStepError` or expired execution can schedule a retry, and only if another attempt and a due time before the existing deadline remain. Unknown executor exceptions are permanent. Database errors outside execution (including uncertain COMMIT responses) do not become invented executor failures; polling resumes and stored state/lease reconciliation decides what remains. This code is not a provider retry policy.

The scheduler uses the same lock order with skipped locked runs. It closes expired running attempts as `EXPIRED`, schedules a bounded retry or fails the run. It transitions due `RETRY_WAIT` to `READY`. Expired deadlines in either waiting or ready states terminate without another attempt. A failed run leaves downstream steps blocked and unclaimable. Repeated scheduler calls have no new transition once nothing is due.

## Boundaries and alternatives

- Transactions provide guarded logical state, not exactly-once computation. A killed worker may have finished computation without recording it; a subsequent attempt may repeat that pure computation.
- A running scheduler and healthy database are prerequisites for progress. Polling interval is not an SLA. Strict FIFO, starvation freedom, arbitrary user-code termination and production capacity are unproven.
- Trusted pinned code and application-managed data are assumptions. There is no dynamic-definition API, workflow parallelism, hostile-worker security boundary, provider, approval system or agent.
- A lease-only design would not identify old attempts; fencing-only checks would not reject expired work before reassignment. Both are retained. A broker would add dual-write/reconciliation concerns without benefiting this milestone's database-local queue.

PostgreSQL documents row locking and the queue-consumer use of [SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE). Its [date/time documentation](https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) distinguishes real clock time from transaction-start timestamps. These references support the primitives; repository tests establish this implementation's finite scenarios, not a general distributed-systems guarantee.
