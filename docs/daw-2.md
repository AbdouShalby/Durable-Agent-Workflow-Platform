# DAW-2: execution and lease-based recovery

## Audit and plan

Baseline: `7fd5ff3e60bb4537085f88fe0ed0966dc0f31198` (completed DAW-1), clean working tree on `codex/daw-1`; no remote. DAW-0's approved sequential, PostgreSQL-backed, version-pinned workflow and DAW-1's source/tests were the design authority. No existing user work required separation. Career Ops, the closed WebSocket lab and shared database/Redis services were out of scope and left untouched.

DAW-1 already admitted an idempotent run, two step rows and one event atomically. It had no executor. Migration 001 and v1 definition metadata/hash remain unchanged. The only DAW-1 test adjustments are asserting two migration records and targeting checksum corruption/restoration to migration 001 instead of every row; all admission, replay, concurrency and rollback assertions remain.

Implementation sequence: extend persistence → transactional claim/fence/recovery → real process entrypoints → PostgreSQL process/failure tests → negative controls → independent standards/spec reviews → evidence/claim reconciliation → scoped checkpoint. No DAW-3/4, LLM, approval, broker or external-effect implementation is included.

## Execution contract

See [ADR 0002](adr/0002-leased-execution.md) for the exact lock order, transition linearization point, persisted policy, deterministic jitter and limitations. See [README](../README.md) for runnable migration/API/worker/scheduler commands.

```text
READY --claim + new fence/attempt--> RUNNING --valid completion--> SUCCEEDED
                                      |                              |
                         retryable failure / expiry           next step READY
                                      |                       or run SUCCEEDED
                                      v
                                  RETRY_WAIT --due scheduler--> READY

permanent failure / exhausted attempts / deadline --> FAILED run
                                                    downstream BLOCKED
```

Lease expiry revokes new transition authority, not the ability of an old process to calculate. Work remains represented durably during process failure. Recovery is conditional on a healthy database, an operating scheduler, remaining attempt budget and remaining deadline; it is not guaranteed recovery under arbitrary failures.

## Reproducible test evidence

`npm run validate` runs DAW-1 and DAW-2 tests against separately owned real PostgreSQL clusters. It never falls back to SQLite, an in-memory queue, skipped prerequisites or synchronous process fakes. All eight admission/claim contenders reach observed simultaneous blocked PostgreSQL sessions. Test IPC merely controls the timing of calls to production functions; normal production worker/scheduler entrypoints also execute end-to-end recovery.

| Scenario | Assertion |
|---|---|
| Eight claim processes at a DB barrier | One returned claim and attempt; seven no-work results; distinct OS/backend PIDs |
| Active lease + duplicate completion | Scheduler cannot steal active work; repeated completion creates no extra result/event |
| SIGSTOP, real expiry, two blocked recovery sessions, scheduler processes, new claimant, SIGCONT | One recovery transition, higher fence; old renew/fail/complete rejected; no stale downstream scheduling |
| Completion waits behind a run lock until expiry | Ownership uses fresh DB time after waiting, not an earlier pre-check |
| SIGKILL after claim; scheduler restart after retry persistence | Same logical run recovers; two production workers finish the deterministic results |
| Injected retryable errors | Persisted calculated jitter/due time, no early claim, three total attempts then terminal failure |
| Repeated SIGKILL | Lease recovery shares the same bounded attempt budget |
| Held executor with real heartbeats | Active lease extends; fixed deadline does not; late result cannot become success |
| Event-insertion database failure | Result/attempt/downstream/event changes roll back together |
| Locked run plus another run | Other run progresses; saved prior result survives worker crash and is consumed without re-execution |
| Deadline while READY or RETRY_WAIT | No extra attempt; scheduler transitions to terminal failure |
| Existing DAW-1 READY/BLOCKED rows upgraded with migration 002 | Original identity/fingerprint/hash preserved; no invented attempts; deterministic execution succeeds |
| Unsupported workflow version | Permanent failure; downstream remains blocked |

Negative controls use test-only loader mutations, never production flags or edited source: unsafe read-then-write claim (removing both lock and conditional protection with a forced DB timing window), ignored owner/fence, ignored lease/deadline, disabled recovery and removed retry limit. Each must fail its named execution test. Existing unconditional-202, disabled-fingerprint and premature-admission-COMMIT controls also remain mandatory. Removing just one redundant claim guard is not necessarily an unsafe implementation; the claim control deliberately models an actual unprotected read/write race.

Seeded jitter is deterministic for fixed identity/policy. OS scheduling, chosen worker and observed milliseconds are not deterministic. Retryable errors are synthetic because the implemented pure steps have no transient external dependency. No provider behavior is inferred.

## Validation and review

Final clean-install gate on **2026-09-05** (`npm ci --ignore-scripts`, then `npm run validate`):

- **30 passed; zero failed, skipped, cancelled or todo**: four unit tests, eleven admission subtests, thirteen execution subtests and two integration parents.
- **Eight negative controls detected** at their intended failing tests; each expected-mutant process exited 1. These are successful regression checks, not failed positive tests. The unsafe claim mutation returned three owners instead of one, demonstrating that the contention assertion catches an actual read/write race.
- Node **24.20.0**, PostgreSQL **18.6**, Linux/WSL2 x64, `fsync=on`, `synchronous_commit=on`. Positive TAP duration about **24.95 seconds**; full compiler/test/negative-control gate **243 seconds**. These durations are not performance benchmarks.
- **35 source/config/test hashes** recorded, with no source changes during validation. The original migration and dependency lockfile are unchanged. The retained manifest is compared with the staged source before committing.
- Missing-infrastructure probe `PG_BIN=/nonexistent/daw2-postgres npm run validate` exited **1**, reporting `initdb ENOENT` for both integration suites with **zero skips**. It is intentionally retained as expected-failure evidence, not a successful gate.
- Positive execution evidence records 27 IPC test actors, five production worker processes, three production scheduler processes and the owned PostgreSQL process; every process has a recorded exit. Admission evidence separately records its API/database processes. Existing shared services were not stopped or reconfigured.
- Clean dependency installation reported zero known npm vulnerabilities at that time, not a full security audit or a permanent guarantee. CI is configured for PostgreSQL 16 but has not been observed running remotely.

Independent **Standards** review found one cleanup/evidence resilience issue in the new test harness. It was fixed using the DAW-1 pattern: independently attempt pool/process cleanup, retain observations, then report aggregated failures. Follow-up review reports zero unresolved findings. Independent **Spec** review and its follow-up report zero unresolved implementation, scope or claim issues. Both reviews were read-only; they did not replace the runtime gate.

### Retained evidence

| Artifact | Purpose |
|---|---|
| [Summary](evidence/daw-2/summary.json), [transcript](evidence/daw-2/validation.log) | Final verdict, exact commands/runtime, tested source hashes, all positive tests and negative-control detections |
| [Execution observations](evidence/daw-2/execution.json) | Claim/recovery backend barriers, OS PIDs, fence changes, attempts, states/results/events and cleanup |
| [Admission observations](evidence/daw-2/integration.json) | Preserved DAW-1 admission concurrency, replay/conflict and restart evidence |
| [Admission control summary](evidence/daw-2/negative-controls.json), [execution control summary](evidence/daw-2/execution-negative-controls.json) | Expected failing assertion/exit per mutant |
| [Claim](evidence/daw-2/claim/tests.log), [fence](evidence/daw-2/fence/tests.log), [expiry](evidence/daw-2/expiry/tests.log), [recovery](evidence/daw-2/recovery/tests.log), [retry limit](evidence/daw-2/retry-limit/tests.log) | Raw failing execution TAP; each sibling `execution.json` preserves observations |
| [Status](evidence/daw-2/status/tests.log), [fingerprint](evidence/daw-2/fingerprint/tests.log), [admission atomicity](evidence/daw-2/atomicity/tests.log) | Preserved DAW-1 negative controls; each sibling `integration.json` preserves observations |
| [Missing PostgreSQL summary](evidence/daw-2/missing-postgres/summary.json), [transcript](evidence/daw-2/missing-postgres/validation.log) | Expected prerequisite failure; sibling admission/execution JSON records empty cleanup |

Raw TAP is retained without formatting edits. `.gitattributes` exempts only end-of-line whitespace diagnostics for the eight exact negative-control log paths, preserving Node assertion formatting without relaxing source checks. Routine outputs remain ignored under `.local/results/`. The manifest's `gitBase` identifies DAW-1; it does not invent a future commit hash. Observation JSON is not a pass verdict: consult its enclosing summary/TAP, especially for intentionally mutated code.

### Sign-off and commit boundary

**DAW-2 is signed off as production-inspired deterministic execution/recovery evidence**, with the limitations below. One checkpoint contains only this repository's execution migration/runtime, tests/validation, current documentation, CI naming and the 26 selected evidence files. No source changes were made after the final gate; documentation/evidence curation was reviewed separately. No private environment files, dependencies, downloaded tooling, compiled output, routine artifacts or unrelated repository files belong in the commit. No remote/push is created. DAW-3 and DAW-4 are not started.

## Limitations and excluded scope

No throughput/load claim, remote CI pass, physical power-loss test, failover test, production usage or arbitrary crash safety claim is made. Tests use one WSL host and check PostgreSQL durability settings. Fencing protects database state only. Polling has no starvation bound. SIGTERM stops new work and waits for in-flight short pure execution; arbitrary blocking/CPU-bound code is not safely preempted. Deadline state can be reconciled late when the scheduler is stopped. Retention, cancellation, tenant management, agent/LLM/tool/approval and external-effect semantics remain outside DAW-2.

Historical DAW-1 documentation/evidence describes that checkpoint, including its then-future DAW-2 boundary. It is retained without rewriting history; this document and the current README describe the new checkpoint.
