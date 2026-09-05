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

**Tool invocation**: Durable external intent bound to one run/step, target identity, contract and exact request fingerprint; not an in-memory call log.

**Effect key**: Stable identity of the intended external write across attempts. Only a provider that honors this identity can deduplicate concurrent or delayed writes.

**Receipt**: Provider result bound to target identity, effect key, fingerprint and expected result. Verification assumes an honest provider; it is not a cryptographic proof.

**UNKNOWN**: The platform cannot safely infer that a possible write failed. Persisted before sending, this state intentionally also covers a crash before any packet leaves.

**Reconciliation required**: Automatic execution is parked because the external outcome or remaining bookkeeping cannot safely be finished under the available contract/budget. No manual resend/override API is supplied by DAW-3.

**Agent proposal**: Untrusted structured model output. Schema validity is necessary but not permission to execute or proof of semantic truth.

**Accepted decision**: A proposal validated by the engine against schema, tool input and evidence-reference rules and durably saved under current ownership before tool dispatch. Resume reuses it.

**Observation checkpoint**: A read-only tool result saved separately from the accepted proposal. Interrupted reads may repeat before this checkpoint; saved observations are reused.

**Agent session budget**: Fixed engine-owned limits for accepted turns, reserved model calls, estimated cost and tool executions; elapsed deadline remains on the step. Lost responses do not refund reservations. The cost ledger is not provider billing enforcement.
