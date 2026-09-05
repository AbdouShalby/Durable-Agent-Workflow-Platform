# Durable Workflow Context

**Workflow definition**: A versioned, trusted description of permitted steps and their order.

**Workflow run**: One admitted request bound to a workflow definition version and fixed input.

**Step**: A logical unit of work in a workflow run. Being scheduled does not mean it has executed.

**Idempotency key**: The caller-scoped identity of a creation request, reusable only for the same intended parameters.

**Request fingerprint**: A digest of the canonical intended request, used to reject incompatible key reuse.

**Initial schedule**: The durable record of which initial step is ready and which later steps are blocked.

**Attempt**: One claimed execution of a step, with immutable identity `(run_id, step_key, attempt)` and a recorded terminal outcome. Pure computation may occur more than once.

**Lease**: Database-time ownership permission until `lease_expires_at`, bounded by the step's persisted deadline. Expiration is not proof that the old OS process stopped.

**Fencing token**: A monotonically increasing per-step integer, checked with owner/state/lease under database locks before result, retry or heartbeat transitions. It does not fence external systems.

**Recovery scheduler**: A separate poller that reconciles expired leases and makes persisted due retries eligible. No in-memory timer owns the work.

**Deterministic recovery policy**: The same run/step/attempt and persisted policy produce the same bounded jitter delay and eligibility decision at a given DB time/state. Process order and elapsed wall time are not deterministic.
