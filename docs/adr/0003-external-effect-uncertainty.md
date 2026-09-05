# ADR 0003: external effects are not platform transactions

Status: DAW-3 implementation decision; production-inspired simulator contract.

## Decision

Keep the approved DAW-0 PostgreSQL execution model and published DAW-1/2 history.
The v1 definition/hash and migrations 001/002 are unchanged. Add incident-triage v2,
whose third step writes its deterministic summary to a local HTTP simulator. Its
required `toolContract` selects one of two trusted contracts (`keyed`, `unkeyed`),
not a caller-selected URL/tool/code. Admission fingerprints include this contract.
Admission atomically persists the three steps and one invocation with immutable-by-
application request, fingerprint, stable logical effect key, service identity and
endpoint. Existing v1 requests need no simulator configuration.

The simulator is a separate process with separate PostgreSQL persistence; tests
even use separate clusters. No platform transaction includes an HTTP request or
can roll back the external write. The simulator owns a durable unique-key ledger
for the keyed contract, rejects conflicting fingerprints, and offers receipt lookup.
The unkeyed contract does not deduplicate or provide reliable lookup. Its normal
success response can be verified, but missing responses cannot be invented.

## State and recovery

Invocation: `PREPARED -> UNKNOWN -> VERIFIED`. UNKNOWN is persisted before the
first send, deliberately including the crash-before-send window. A request counter
records authorized send attempts, not proof that packets reached the provider.
Only the current leased/fenced owner may authorize sending or save a receipt.
No client-side transaction/lease can fence a remote HTTP write after an OS pause.

After a possible write, timeout, invalid receipt or transport error is uncertainty,
not proof of rollback. On a later keyed attempt, GET verifies the stored receipt.
Only an explicit 404 with the reliable keyed contract permits a same-key resend;
even this is not proof that the old request will not commit later. Concurrent/late
writes converge only because the external service honors that key durably.
Unavailable verification does not trigger a POST. The key excludes attempt/fence.

For unkeyed ambiguity, the step becomes `UNKNOWN` and the run becomes
`RECONCILIATION_REQUIRED` immediately; schedulers/workers cannot automatically
reclaim it. Exhausted attempts/deadlines with a possibly sent effect also park,
including a verified receipt whose step could not be completed in budget. Receipt
state distinguishes known effect outcome from unfinished platform bookkeeping.
Keyed verification uses the existing bounded attempt/backoff/deadline budget;
this is not indefinite guaranteed recovery. A human must inspect independent
evidence before any future correction. DAW-3 provides no manual override/resend,
approval or reconciliation-resolution endpoint.

Verified receipts bind service identity, effect key, request fingerprint and exact
result. Receipt persistence is fenced and transactional with its event. Completion
requires the saved receipt and retains DAW-2's fenced result/downstream transaction.
A crash between receipt persistence and step completion reuses that receipt; it
does not call the external write again. Source/data under application control and
an honest service are assumptions: this is not cryptographic attestation of a
malicious provider, hostile-worker isolation, or protection against manual DB edits.

## Reproducibility and limits

Simulator fault modes are explicit process-start options: normal, hold-response
after COMMIT, bad-receipt, lookup-unavailable and reject-before-write. They do not
alter the platform's transport. Loopback HTTP and test-owned trust-auth PostgreSQL
are for trusted local showcase use, not deployment security recommendations.
Service identity is persisted separately and checked on every request; changing
its backing store while reusing identity/keys violates the simulator contract.
No retention/expiry, cross-region failover, arbitrary crash safety, exactly-once
workflow, production provider integration, agent, LLM or approval claim is made.
DAW-4 through DAW-7 remain out of scope.
