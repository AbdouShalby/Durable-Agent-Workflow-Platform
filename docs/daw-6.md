# DAW-6: operational evidence

Baseline: published `7c3146a9bfcd8df98ba3ac9c2ff234c2137ec7e4`, clean main. Approved DAW-0 and the explicit DAW-6 request define scope. This is production-inspired evidence, not production certification.

## Audit and plan

The baseline has liveness only, startup table probes, 16-connection pools, database-side timeouts, a 100ms polling loop, and shutdown waiting for work/pool drain without an outer deadline. Durable journals already expose attempts, leases, retries, receipts and approvals. DAW-1 through DAW-5's 94 tests and 20 mutation controls are preserved.

Add only: schema/database readiness, separate bounded operational query capacity, an HTTP in-flight cap, bounded process drain, low-cardinality aggregate JSON telemetry, and structured attempt-span/role lifecycle logs. No schema migration, new workflow, new tool, broker, collector, dashboard or dependency is needed. Readiness does not promise worker availability or provider/LLM health. Attempt spans are local JSON correlation evidence, not an implemented OpenTelemetry exporter or cross-service trace propagation.

Prove using owned PostgreSQL clusters and actual processes: outage/recovery with a lost worker lease; live-versus-ready behavior and schema mismatch; API graceful and forced drain with a blocked transaction; worker graceful drain and forced exit followed by recovery; HTTP saturation bounds; telemetry counts and privacy. Keep all earlier failure/approval/external-effect cases and add operational outage, readiness, request-limit, shutdown and telemetry mutation witnesses.

The full gate, independent Standards/Spec review and machine-readable evidence below complete local sign-off. The commit boundary is DAW-6 only; DAW-7 and publication are excluded.

## Operational contracts

See the [runbook](runbooks/operations.md) and [ADR 0006](adr/0006-operational-boundaries.md) for commands, signal interpretation and response steps. No dependency, migration, workflow version or independent simulator behavior changed. Historical test assertions and mutation fixtures remain unchanged. Effect/approval fixtures additionally preserve original failure details when cleanup also fails; failures still fail the gate.

- `/healthz` answers without querying PostgreSQL. `/readyz` reads schema capabilities and compares the exact migration identity; errors, draining and overload produce 503, never a cached healthy response. All process roles fail closed on initial readiness failure.
- A separate two-connection operational pool bounds probe/query capacity. The primary pool remains 16 connections per process. At most 32 non-health API handlers execute concurrently; overflow is 503. This is not a socket/parser/memory limit.
- SIGTERM/SIGINT stops new admission/polling. Cooperative completion exits cleanly; a five-second event-loop timer forces code 1 if draining stalls. It does not preempt synchronous code, SIGSTOP or host failure. Existing leases and uncertainty records remain authoritative.
- Operator-only `/operations` returns 18 fixed numeric fields including schema version, queue age/depth, lease/retry/recovery states, reconciliation/approval/cancellation totals and API pool/handler state. These are retained-row gauges, not per-run labels or forever-monotonic counters. Large retained histories can exhaust the probe statement timeout.
- JSON attempt spans correlate run/step/attempt/fence without payloads or secrets. Role logs distinguish progress, infrastructure failures and shutdown. These are local logs, not a durable trace backend, OpenTelemetry integration or cross-service propagation.

The real outage scenario exposed a pre-existing unhandled checked-out PostgreSQL Client error that killed the worker. The minimal fix installs a fixed-message error listener on each connected client. Failed queries still reject; no business success/failure is invented to hide unavailable storage. A negative control removes that listener and must fail the same outage witness.

## Failure witnesses and boundaries

| Real process / database witness | Required result |
| --- | --- |
| Alter migration checksum, then temporarily hide a required table in the owned DB | Readiness 503 while liveness remains 200; restored schema returns readiness 200 |
| Stop owned PostgreSQL while worker completion waits behind an advisory lock, then restart the same directory/port | Admission fails during outage; same worker and scheduler survive, expired work completes, stale completion returns false |
| Hold API INSERT behind a table lock, SIGTERM, then release within drain window | Response 202 and exit 0; restarted API replays the original key as 200 with the same run |
| Keep API INSERT blocked through the drain deadline | Exit 1, no admitted row in this pre-INSERT window; retry after restart can create it |
| Hold worker completion, SIGTERM and release promptly | Current step completes, downstream is not claimed by the draining worker; replacement finishes |
| Keep worker completion blocked through the deadline | Exit 1, lease recovery and replacement completion; no fabricated success |
| 32 simultaneous HTTP requests blocked at the database, with 16 backend lock waiters observed | Overflow rejected as overloaded; liveness still answers; released requests complete and pool waiting returns to zero |
| Real retry scheduling and operator telemetry, plus a slow query on the probe pool | Exact finite field set, correct retry/ready counts, no run/input values in metrics, server-side query cancellation |

The capacity witness launches all 32 requests before releasing the lock; it is not a sequential loop presented as concurrency. The barrier observes the 16 primary backend waiters and gives queued handlers a short settling interval. This finite host test establishes the implemented cap, not throughput, memory capacity or every possible interleaving.

The five operational mutations remove checked-out client error handling, readiness identity checking, forced shutdown exit, handler admission limiting, or fixed-field telemetry discipline. The automated check requires exit code 1 and failure of the named test. It cannot by itself distinguish an unrelated startup failure inside that same test; sign-off additionally inspects the retained failure reason for the intended safeguard. These complement, not replace, the twenty earlier admission/execution/effect/agent/approval controls.

DAW-1/2 tests remain the authority for atomic admission, bounded attempts/backoff/deadlines, leases and stale-worker fencing. DAW-3 tests still use independently persisted HTTP effects for UNKNOWN and conservative reconciliation. DAW-4/5 retain accepted-decision restart, agent budgets, approval expiry/binding, simultaneous approval and cancellation races. DAW-6 does not claim a cross-product of every operational fault with every workflow state.

## Reproduction and limitations

Two preliminary parallel-file gates failed before sign-off. [September 6](evidence/daw-6/diagnostics/parallel-2026-09-06/summary.json) and [September 8](evidence/daw-6/diagnostics/parallel-2026-09-08/summary.json) retain their FAILED summaries and sibling raw transcripts. Failures occurred in startup/setup, including explicit seven-second API-listening timeouts; effect/approval cleanup masked original startup errors when external tables were absent. The older record cannot identify those masked causes conclusively. These failed runs are diagnostics, never passing evidence.

The harness now runs one independent test-file/cluster group at a time. This bounds host resource contention without serializing any actors inside a race, changing timeout thresholds or removing assertions. Effect/approval fixtures preserve original failure details in addition to cleanup errors. A [third failed gate](evidence/daw-6/diagnostics/serial-windows-mount/summary.json) showed that group isolation alone was insufficient: its [effect journal](evidence/daw-6/diagnostics/serial-windows-mount/effects.json) records simulator-listening timeouts, sometimes masked by missing external tables during cleanup.

A separate three-run `node -e 'import("fastify").then(()=>console.log("import-ready"))'` comparison measured 3.978/1.976/4.299 seconds on the Windows-mounted source versus 0.086/0.086/0.081 seconds on a native Linux snapshot with the same pinned Node/dependencies. This supports filesystem/module-loading latency as a contributor; it is not a capacity benchmark or proof of every masked historical cause. The final gate uses the native snapshot, with all 65 source/config/test hashes matched against the original checkout. No new repository, timeout increase or application-policy change is used for that validation. See the runbook for reproduction.

Run `npm ci --ignore-scripts` then `npm run validate` with Node 24.20.0 on Linux/WSL and real PostgreSQL binaries. The gate requires all tests, no skips, no live model adapter or selected-case mutation settings, all named negative controls and unchanged source hashes. Owned clusters retain data; only owned child PIDs are stopped. Routine output stays ignored under `.local/results/`; reviewed evidence is separately curated below.

This proves representative service/process failure windows on one host, not production traffic, power/disk loss, network blackholes, failover, universal crash safety, an availability SLO or exactly-once execution. Readiness is not writable-primary or provider/worker health. A live lease is not proof the worker is alive. Forced exit does not establish rollback of an external request. Recovery still depends on healthy durable storage, valid policy budgets and a running scheduler. No manual uncertainty override or approval bypass is added. No DAW-7 work or changes to other portfolio repositories are included.

## Final evidence and local sign-off

**DAW-6 signed off locally on 2026-09-08 as a production-inspired operational showcase.** The final gate ran from `2026-09-08T03:42:41.834Z` to `03:47:22.352Z` (UTC), on Node `v24.20.0`, Linux x64/WSL2 and real PostgreSQL **18.6**, with `fsync` and `synchronous_commit` enabled. All **103 positive tests** passed, with zero failures, skips, cancellations or todos; counts include parent tests. All **25 expected-failure mutation controls** were detected. The four offline credential-guard tests passed. No live model/provider was contacted.

The native validation snapshot was `/var/tmp/daw6-native-bw2KkkYZ`, using the existing repository's read-only Git metadata and the retained owned temporary root `/var/tmp/daw5-validation-SWNbzDZM`. All **65 source/config/test hashes** matched the original candidate before and after validation; the gate also rejected source drift internally. All **seven manifest/transcript SHA-256 bindings** were independently checked. No application/test/validation source changed after this gate.

All **62 final artifacts** were copied byte-for-byte and hash-compared. Seven separately labelled diagnostics retain three failed Windows-mounted runs, for **69 curated files** total. Those failures are not counted as passes or hidden by the native result. Post-curation secret scanning passed across **315 files with zero findings**; this is a bounded offline guard, not a proof against every possible secret pattern. Exact log-only whitespace attributes preserve original diagnostic formatting. Private runtime configuration, dependencies, compiled output, routine results and test clusters are excluded from the commit.

| Evidence | Scope |
| --- | --- |
| [Summary](evidence/daw-6/summary.json), [raw transcript](evidence/daw-6/validation.log) | Exact commands, source/runtime identity, 103 tests and 25 mutation verdicts |
| [Operations journal](evidence/daw-6/operations.json) | Eight real scenarios, snapshots/spans, 20 owned process records with recorded exits; same-worker outage recovery and stale rejection |
| [Admission](evidence/daw-6/integration.json), [execution](evidence/daw-6/execution.json) | Actual simultaneous backend barriers, durable identity, leases, fencing, retries and deadlines |
| [Effects](evidence/daw-6/effects.json), [agents](evidence/daw-6/agent.json), [approvals](evidence/daw-6/approvals.json) | Independent external persistence, UNKNOWN, checkpoint reuse, budgets and governed cancellation/approval boundaries retained |
| [Admission mutations](evidence/daw-6/negative-controls.json), [execution mutations](evidence/daw-6/execution-negative-controls.json), [effect mutations](evidence/daw-6/effect-negative-controls.json), [agent mutations](evidence/daw-6/agent-negative-controls.json), [approval mutations](evidence/daw-6/approval-negative-controls.json) | Twenty historical controls, with sibling raw failure logs |
| [Operational mutations](evidence/daw-6/operations-negative-controls.json) | Five new controls, reviewed against the specific failure below |

Operational failure-reason review:

| Disabled safeguard | Observed failure |
| --- | --- |
| [Checked-out client error handling](evidence/daw-6/operations-outage/tests.log) | Actual worker exits 1 with unhandled Client connection error instead of surviving the owned PostgreSQL outage |
| [Readiness identity](evidence/daw-6/operations-readiness/tests.log) | Mismatched schema returns 200 instead of required 503 |
| [Shutdown deadline](evidence/daw-6/operations-shutdown/tests.log) | Already-running blocked worker fails the bounded-shutdown wait, not its startup wait |
| [Handler cap](evidence/daw-6/operations-capacity/tests.log) | Overflow request waits instead of receiving bounded overload rejection; TAP renders the error text empty, so an additional unchanged-source focused run with the spec reporter confirmed `TimeoutError: The operation was aborted due to timeout` |
| [Finite telemetry fields](evidence/daw-6/operations-telemetry/tests.log) | Exact-key assertion detects an added run_id field |

The positive worker forced-drain witness recorded about 5018ms to exit and one expired attempt recovered; graceful drain recorded about 42ms and no downstream claim by the old worker. These observed durations are individual test results, not latency guarantees. Metric labels remain finite; correlation IDs exist only in logs.

### Standards review

**Zero unresolved hard violations.** Review clarified handler versus socket/memory bounds, retained-row gauge cost, event-loop versus OS termination and local versus propagated tracing. The startup SIGTERM/listener-registration gap was closed before the final gate. Final evidence hash and secret checks were performed after curation. Reviewers did not run the tests; the gate supplies execution evidence.

### Spec review

**Zero unresolved findings.** A documentation overclaim about automatic mutation attribution was corrected: the runner checks exit/name, while sign-off separately inspects the intended failure. Native snapshot validation preserves exact sources and all test deadlines; it does not certify mounted-Windows startup performance. Independent group scheduling leaves all in-scenario races intact. No new workflow, tool, migration, dependency or DAW-7 capability was added.

This is a local commit/sign-off boundary only, not a GitHub publication or CI result for this candidate. Historical milestone evidence remains unchanged. No other portfolio repository or Career Ops was modified.
