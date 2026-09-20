# Durable Agent Workflow Platform

## Engineering Overview

A production-inspired TypeScript/PostgreSQL lab for durable incident-triage workflows. It demonstrates transactional run creation, request idempotency and concurrent workers with atomic claims, leases and fencing. Bounded retries and conservative external-effect reconciliation handle uncertainty; durable human approvals bind authorization to the exact proposed action. Readiness checks, bounded shutdown and operational telemetry make failure and recovery observable.

The evidence comes from real PostgreSQL and independent processes, with a simulated external service and deterministic agent tests. It does **not** establish production deployment, production traffic, throughput/SLOs or live LLM usage.

## Evidence Index

| Milestone | Engineering question | Strongest public evidence |
| --- | --- | --- |
| DAW-1 | Can concurrent requests create only one durable logical run? | [Admission races and atomic rollback](docs/evidence/daw-6/integration.json) / [original scope](docs/daw-1.md) |
| DAW-2 | Can expired work recover without accepting stale-worker results? | [Execution, leases and fencing](docs/evidence/daw-6/execution.json) / [contract](docs/daw-2.md) |
| DAW-3 | What happens when an external write may have succeeded? | [Independent effects and reconciliation](docs/evidence/daw-6/effects.json) / [contract](docs/daw-3.md) |
| DAW-4 | Can a bounded agent resume accepted decisions safely? | [Agent checkpoints and budgets](docs/evidence/daw-6/agent.json) / [contract](docs/daw-4.md) |
| DAW-5 | Can human authorization survive retries, expiry and cancellation races? | [Approval and cancellation witnesses](docs/evidence/daw-6/approvals.json) / [contract](docs/daw-5.md) |
| DAW-6 | How do services behave during outage, shutdown and overload? | [Operational failure witnesses](docs/evidence/daw-6/operations.json) / [full validation summary](docs/evidence/daw-6/summary.json) / [runbook](docs/runbooks/operations.md) |

The DAW-6 gate revalidates the earlier contracts; historical milestone records remain available. Public artifacts with redacted local paths are **presentations of preserved original evidence**, not byte-identical raw logs. See the [evidence publication rules and hash ledger](docs/publication/README.md) before checking historical artifact hashes. Source fingerprints, results, timings and incident chronology are unchanged.

## Detailed Scope

A production-inspired architecture lab. **DAW-6 adds readiness, bounded draining, operational signals and reproducible outage/recovery evidence.** Real worker/scheduler processes coordinate through PostgreSQL. V4 composes the existing bounded read-only agent with the existing keyed external-effect simulator; high-severity actions wait for a separately authenticated approver. No new write-capable agent tool or multi-agent runtime is implemented. The real model adapter has offline contract tests, not live-provider evidence.

The foundation accepts a versioned incident-triage request, atomically persists its run, initial step states and creation event, and returns a durable run identity. Concurrent duplicate requests use PostgreSQL uniqueness as the authority, not an in-memory lock or a pre-check. This is showcase evidence, not production usage or exactly-once execution.

See [DAW-5 contracts and evidence](docs/daw-5.md), [governed-approval decision](docs/adr/0005-governed-approval.md), [historical DAW-4 contracts and evidence](docs/daw-4.md), [bounded-agent decision](docs/adr/0004-bounded-agent.md), [historical DAW-3 scope and evidence](docs/daw-3.md), [external-effect decision](docs/adr/0003-external-effect-uncertainty.md), [historical DAW-2 evidence](docs/daw-2.md), [historical DAW-1 evidence](docs/daw-1.md), [admission decision](docs/adr/0001-postgres-admission.md), [execution decision](docs/adr/0002-leased-execution.md), and [domain terms](CONTEXT.md).

## What exists

Current operational contracts: [DAW-6 evidence](docs/daw-6.md), [operations runbook](docs/runbooks/operations.md), and [operational boundaries](docs/adr/0006-operational-boundaries.md). Earlier milestone evidence remains historical.

- Strict TypeScript; pinned Node **24.20.0**; exact dependencies and committed npm lockfile.
- PostgreSQL migrations with transactional application, a migration lock and checksum validation.
- Local token-protected HTTP API: create a run and read its persisted schedule.
- A deterministic `incident-triage` v1 executor: `normalize-incident` then `build-summary`, consuming the saved prior result.
- Opt-in `incident-triage` v2 adds `write-summary`. Each run binds its `keyed`/`unkeyed` simulator contract, target identity, payload fingerprint and stable effect key durably. V1 semantics and historical hashes are unchanged.
- Opt-in v3 instead adds `analyze-incident`: accepted model decisions and read-only observations are separately checkpointed. The engine enforces schema/tool/evidence policy and fixed turn, call, estimated-cost and elapsed-time limits. The model cannot approve, change policy or mark the workflow successful.
- Opt-in v4 composes that agent with the existing keyed write-summary contract. A pinned policy requires approval for high severity, bound to the exact action, target, run/step/tool, policy and expiry; low severity needs no approval. Pending approvals survive restart. Cancellation prevents new work or conservatively parks an already-authorized effect for reconciliation.
- Atomic step claims, persisted attempts, leases, monotonically increasing per-step fencing tokens and a recovery scheduler. Only one step per run can have valid ownership; separate runs can progress independently.
- Bounded exponential retries with reproducible seeded jitter, persisted due times, a maximum attempt count and a per-step deadline.
- Real PostgreSQL / independent HTTP-process tests, including database lock barriers, rollback injection, persistence across process/database restart and regression controls.

## State and consistency contract

V1 admission below; v2 additionally saves its external invocation and v3 its agent session, each with a third initially blocked step in the same transaction. V4 atomically saves its agent session, fixed governance policy/target and fourth blocked step. It prepares the exact invocation/approval only when the engine accepts the agent result.

```text
POST /runs
  └─ PostgreSQL transaction
       ├─ workflow_runs: QUEUED
       ├─ step_runs: normalize-incident READY / build-summary BLOCKED
       └─ run_events: RUN_CREATED
          ↓ COMMIT
        HTTP 202
```

`READY` means durably eligible, not executed. `available_at` is database time, not a JavaScript timer. Without a running worker, runs remain `QUEUED`. Workers move eligible steps through `RUNNING` to `SUCCEEDED`, atomically releasing the next step or completing the run. Retryable failures/expired leases enter `RETRY_WAIT`; the scheduler makes due retries `READY`, or fails exhausted/deadline-expired work. Permanent failures terminate immediately. Downstream steps stay `BLOCKED` on failure.

V4 may instead persist `WAITING_APPROVAL` without holding a write-step attempt/lease. Approval, expiry and cancellation use the engine's run-first locks. Previously authorized uncertain work is reconciled conservatively; cancellation does not imply an external rollback. See DAW-5 for the exact state and expiry boundaries.

The unique key is `(caller_id, idempotency_key)`. The API authenticates one configured local operator; caller scope is server-assigned, never taken from a client header. Token rotation does not change that caller identity. V4 adds a distinct optional approver capability for reading and deciding approvals, never model self-approval. This is not multi-user authorization.

The fingerprint is SHA-256 of a fixed-field JSON representation of workflow name, explicit version and validated input. Object-key order is irrelevant. Values are preserved: whitespace changes in a title are a different intended request, even though normalization trims the title. Unknown properties, omitted required fields and type coercion are rejected rather than silently changing identity. Definition metadata/hash is saved with the run; v1 semantics must not be edited into a different workflow under the same version. The metadata hash is not an executable-code hash.

The losing `INSERT ... ON CONFLICT DO NOTHING` reads the committed winner in a **new statement** under explicit READ COMMITTED isolation. It returns replay only when fingerprints match. It never decides creation status from an earlier pre-check. Run, initial steps and event are in the same transaction; v2 also includes its durable invocation and v3 its agent session/policy. No database/broker dual write exists. Later HTTP effects and model calls are explicitly outside that transaction. Raw SQL callers or database administrators can violate higher-level invariants: this is an application transaction contract, not a claim that arbitrary manual writes are safe.

## Prerequisites

- Node 24.20.0 (use `.nvmrc`) and its bundled npm; Git.
- `npm ci --ignore-scripts` installs the locked dependencies. No API key or paid service is required.
- Full validation: Linux/WSL, a non-root user, and real PostgreSQL `initdb`/`postgres` binaries. `PG_BIN` defaults to `/usr/lib/postgresql/18/bin`. Local evidence uses PostgreSQL 18.6; CI is configured to install PostgreSQL 16 on Ubuntu 24.04. A local result is not a remote CI pass or a compatibility certification for untested versions.

Do not run the tests against a shared database. They always create their **own** cluster and choose loopback ports; `DATABASE_URL` is not used to select the test database. Missing binaries fail the suite; there is no SQLite, in-memory database or skip fallback. Test-only trust authentication is limited to the owned cluster on loopback, suitable only on a trusted local machine.

## Validate

```sh
npm ci --ignore-scripts
npm run validate
```

For another installed PostgreSQL binary directory:

```sh
PG_BIN=/usr/lib/postgresql/16/bin npm run validate
```

`validate` checks the pinned Node version and credential guard, typechecks, builds, runs unit/integration/evaluation tests, rejects failures/skips/cancellations/todos and executes twenty-five expected-failure mutation controls (three admission, five execution, four external effects, four agent controls, four approval controls, five operational controls). Output is `.local/results/<timestamp-uuid>/`: source hashes, runtime, exact commands, positive TAP transcript, PostgreSQL backend/process evidence and negative-control logs. Source drift during the gate fails it. Test counts include integration parent tests; see the retained TAP for individual scenarios.

Tests start independent API child processes, not Fastify injection. Eight identical requests are held at a real PostgreSQL table lock until all eight backend sessions are observed blocked in INSERT, then released together. Exactly one must return 202 and seven 200, with one logical run. V1 has two initial steps; v2 has three and one durable invocation. Conflicting fingerprints return 409. This proves finite races on one host, not load capacity or strict FIFO fairness.

The full gate runs one test file/owned-cluster group at a time (`--test-concurrency=1`) to bound harness resource contention. Concurrent processes and HTTP requests **inside** each race still run simultaneously behind observed database barriers. No business timeout or assertion is relaxed by this harness scheduling choice.

Execution tests also hold eight real child-process claim queries behind a database barrier. Separate processes exercise production claim/renew/complete/fail functions; test-only IPC gates expose failure windows. Unmodified worker and scheduler entrypoints prove end-to-end recovery. `SIGSTOP`/`SIGCONT` exposes stale ownership; `SIGKILL` interrupts owned workers. Tests observe DB-time expiry rather than substituting an in-memory clock. The injected retryable failure is synthetic: the shipped deterministic steps have no natural transient external dependency.

Test teardown stops only owned PIDs. Temporary clusters under the OS temporary directory are retained for inspection, not recursively deleted. No images, volumes, existing services or user databases are removed. Hard termination of the entire harness/OS is not a process-tree cleanup guarantee.

## Run the local API

Use a dedicated PostgreSQL database. Optional Compose supplies **only** a database on loopback port 15432 (check it is free). Example for a POSIX shell with Node on PATH:

```sh
export DAW_DB_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export OPERATOR_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
docker compose up -d postgres
export DATABASE_URL="postgresql://daw:${DAW_DB_PASSWORD}@127.0.0.1:15432/daw"
npm run build
npm run migrate
npm start
```

Run commands from the repository root. Migration/start commands target the explicit `DATABASE_URL`; unlike tests, they do not provision a database. Run migrations only against the intended dedicated database. Existing Compose volumes keep their original credentials; keep the same private password when restarting, rather than generating a replacement for an initialized volume.

In separate terminals with the **same dedicated `DATABASE_URL`** and pinned Node runtime, start execution and reconciliation independently:

```sh
npm run worker
```

```sh
npm run scheduler
```

Multiple copies are supported; each worker executes at most one step at a time. Workers/schedulers wait 100 ms when idle and 500 ms after an error; a JavaScript poll merely wakes a process, it is not the durable schedule. SIGTERM/SIGINT stops new polls/admission and drains current operations, with a five-second event-loop timer forcing nonzero exit if draining stalls. This cannot preempt a blocked event loop or arbitrary user code. Database failures log fixed signals and retry polling; uncertain completion is resolved from durable state/lease expiry, not blindly classified as a step failure. Start migrations before **all** roles. Startup readiness failure exits instead of polling. No process supervisor is included.

The API binds **127.0.0.1** only, defaults to port 8080 (`PORT=0` selects an available port), and requires `OPERATOR_TOKEN` of at least 32 characters. Never commit tokens or connection strings. Migrations are explicit, not run automatically by the API. Startup requires database/schema readiness. `/healthz` is liveness only; `/readyz` checks database connectivity, readable capabilities and exact migration identity. Readiness is point-in-time, not a writable-primary, worker or provider health guarantee. Operator-protected `/operations` exposes finite-name aggregate gauges using a separate two-connection probe pool. The API caps concurrent executing non-health handlers at 32, not total sockets or process memory. See the runbook for query/handler limits and log privacy. This configuration is not a public-ready authenticated service: no TLS or tenant management is supplied. V4 adds only the separate local approver capability described in DAW-5, not general-purpose identity management.

From a second terminal with the same private operator token:

```sh
curl -i http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-incident-1' \
  --data '{"workflow":"incident-triage","version":1,"input":{"title":"Café incident","severity":"high"}}'
```

First response: HTTP **202**, `{run_id, state:"QUEUED", replayed:false}`, plus `Location: /runs/<run_id>`. Repeating the same request returns **200**, the same `run_id`, and `replayed:true`. Change severity to `low` with the same key: **409** with `{"error":"idempotency_conflict"}`. Use a new key for a genuinely new request, not to bypass uncertainty after an interrupted response.

`GET /runs/<run_id>` with the same Authorization header returns workflow/version/definition hash, original input, state, creation time and ordered steps. Steps include `attempt_count`, `fence`, `available_at`, `lease_expires_at`, `deadline_at`, `result` and `last_error`. A replay returns the same identity with its current state (possibly `RUNNING`, `SUCCEEDED` or `FAILED`), not a frozen initial response. Unknown IDs return 404. Invalid requests return 400, oversized/unsupported payloads 413/415, missing/bad authorization 401. Storage or unexpected server failures return generic 503 without SQL, inputs or credentials. If the response was lost around COMMIT, retry the original key/input; do not assume the transaction failed.

Execution defaults are persisted per step: 3-second lease, three total attempts, retry base 200 ms/cap 2 seconds, and a 30-second elapsed budget beginning at the first claim. Heartbeats every `floor(lease_ms / 3)` cannot extend that deadline. An expired lease cannot be renewed. Recovery requires a healthy database and a running scheduler; workers alone do not revive expired work. Deadline exhaustion is reconciled when a scheduler gets to it, not a wall-clock response SLO. Policy is not an HTTP input or hot-reload feature.

## External-effect demo (v2; v4 setup also uses this simulator)

Provision a **separate dedicated PostgreSQL database** for the simulator first.
Set `SIMULATOR_DATABASE_URL` privately to that database; never use the platform's
database. Tests enforce stronger isolation with two independent owned clusters.
The simulator creates only its own tables on startup and has no platform imports.
Use the same pinned Node and build as the platform, then in the simulator terminal:

```sh
export SIMULATOR_SERVICE_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
export SIMULATOR_PORT=18081
npm run simulator
```

Retain that service ID across restarts; startup rejects an ID different from the
one already saved in the simulator database. Start the API with
`EFFECT_SERVICE_URL=http://127.0.0.1:18081` and `EFFECT_SERVICE_ID` set to that same
ID, alongside its original platform `DATABASE_URL` and `OPERATOR_TOKEN`. These are
operator configuration, not request-supplied URLs. Admission persists the target;
changing worker environment cannot silently reroute an existing invocation.

With the same authentication and Idempotency-Key headers as the v1 example, submit:

```json
{"workflow":"incident-triage","version":2,"toolContract":"keyed","input":{"title":"Representative incident","severity":"high"}}
```

Run the existing worker/scheduler processes. V2 performs the two saved pure steps
then writes their summary through HTTP. `GET /runs/<id>` also exposes `tools`:
stable effect key, contract, state, authorized-send/verification counters and receipt.
V1 returns `tools: null` and still executes no external effect. Changing contract
with the same admission key is a fingerprint conflict (409).

`keyed` means the **simulated provider** atomically deduplicates a key and supports
receipt lookup. `unkeyed` intentionally lacks that protection. Before the first
send, the platform durably records `UNKNOWN`. A 700-ms client timeout is not proof
of external rollback. Later keyed attempts verify first; only not-found permits
same-key resend, relying on the provider's deduplication even for late requests.
Unavailable lookup does not authorize a POST. Receipts bind service/key/request
and exact expected result, under the trusted-provider assumption.

For a lost-response demo, start the simulator with
`SIMULATOR_FAULT=hold-response`: it commits its write and withholds the reply.
Restart it normally at the **same port, service ID and database**. A keyed run
can reconcile within its existing retry/deadline budget. An ambiguous unkeyed
run parks its step at `UNKNOWN` and its run at `RECONCILIATION_REQUIRED`, without
automatic re-execution. Exhausted keyed verification also parks. A human must
inspect independent evidence; no uncertainty override/resend/resolution endpoint is included. V4 approval is pre-dispatch authorization, not an uncertainty override.
Receipt preservation distinguishes a known completed effect from unfinished
platform bookkeeping. Do not create a new run/key to bypass this uncertainty.

Other simulator faults are `bad-receipt`, `lookup-unavailable` and
`reject-before-write`. They are local reproducibility controls, not real provider
integrations. No auth/TLS boundary is provided by the simulator; use a trusted
loopback-only environment. Stable service identity is a binding check, not a secret.

## Boundaries

- PostgreSQL durability depends on its storage and configuration. Tests keep `fsync` and `synchronous_commit` enabled and check normal same-directory database restart. They do not simulate power loss, disk loss, replication failover or arbitrary crash safety.
- Duplicate **attempts** are possible; one run identity under the validated key scope is not exactly-once workflow execution.
- No run deletion/idempotency expiry API exists. Retention and archival policies remain unspecified; manual deletion would change replay behavior.
- Fencing protects PostgreSQL transitions, not external systems. An old process may still compute after expiry but cannot authorize a new result/downstream transition. The ownership check under locks is the linearization point; physical COMMIT may occur later. No arbitrary-executor preemption, starvation bound or cross-host clock/disaster guarantee is demonstrated.
- The summary-writing simulator is never an agent tool: v4's engine schedules it under a fixed approval policy. Agent tools remain local synthetic read-only data. V4 approvals/cancellation do not provide compensation, manual reconciliation overrides or multi-tenant identity. No dynamic DAG, broker, arbitrary code execution or multi-agent orchestration exists. DAW-7 is not started.
- No HTTP load benchmark, latency SLO, production traffic, provider integration or production AI experience is established.

## Layout

`src/domain/` holds versioned definitions, fingerprints, receipt/agent/tool/approval rules and retry calculation; `src/application/` admission/execution/effect/agent checkpoint and approval/cancellation coordination; `src/agents/` isolated model adapters; `src/persistence/` PostgreSQL and migrations; `src/http.ts` the HTTP boundary; `src/entrypoints/` API/migration/worker/scheduler commands; `src/simulator/` the independently persisted HTTP effect service. `tests/` contains pure contracts, deterministic evaluations and real infrastructure scenarios; `tests/fixtures/` contains explicit test-only source mutations. `scripts/` drives reproducible validation. `docs/evidence/` retains selected reviewed output; routine artifacts, dependencies and compiled output stay ignored.
