# Durable Agent Workflow Platform

A production-inspired architecture lab. **DAW-1 implements durable workflow admission and initial scheduling only.** It does not run a worker, execute a workflow, invoke an LLM, call external tools or recover expired leases. The project name describes the approved direction, not capabilities already delivered.

The foundation accepts a versioned incident-triage request, atomically persists its run, initial step states and creation event, and returns a durable run identity. Concurrent duplicate requests use PostgreSQL uniqueness as the authority, not an in-memory lock or a pre-check. This is showcase evidence, not production usage or exactly-once execution.

See [DAW-1 scope and evidence](docs/daw-1.md), [architecture decision](docs/adr/0001-postgres-admission.md), and [domain terms](CONTEXT.md).

## What exists

- Strict TypeScript; pinned Node **24.20.0**; exact dependencies and committed npm lockfile.
- PostgreSQL migrations with transactional application, a migration lock and checksum validation.
- Local token-protected HTTP API: create a run and read its persisted schedule.
- A deterministic `incident-triage` v1 definition: `normalize-incident` then `build-summary`. Pure functions are unit-tested, but no executor calls them yet.
- Real PostgreSQL / independent HTTP-process tests, including database lock barriers, rollback injection, persistence across process/database restart and regression controls.

## State and consistency contract

```text
POST /runs
  └─ PostgreSQL transaction
       ├─ workflow_runs: QUEUED
       ├─ step_runs: normalize-incident READY / build-summary BLOCKED
       └─ run_events: RUN_CREATED
          ↓ COMMIT
        HTTP 202
```

`READY` means durably eligible for a future executor; it does not mean execution occurred. `available_at` is database time, not a JavaScript timer. DAW-1 runs remain `QUEUED` indefinitely. No success/retry/recovery state is invented to suggest later milestones exist.

The unique key is `(caller_id, idempotency_key)`. The API authenticates one configured local operator; caller scope is server-assigned, never taken from a client header. Token rotation does not change that caller identity. This is not multi-user authorization.

The fingerprint is SHA-256 of a fixed-field JSON representation of workflow name, explicit version and validated input. Object-key order is irrelevant. Values are preserved: whitespace changes in a title are a different intended request, even though the future normalization step trims the title. Unknown properties, omitted required fields and type coercion are rejected rather than silently changing identity. Definition metadata/hash is saved with the run; v1 semantics must not be edited into a different workflow under the same version.

The losing `INSERT ... ON CONFLICT DO NOTHING` reads the committed winner in a **new statement** under explicit READ COMMITTED isolation. It returns replay only when fingerprints match. It never decides creation status from an earlier pre-check. Run, two initial steps and event are in the same transaction; no database/broker dual write exists. Raw SQL callers or database administrators can violate higher-level invariants: this is an application transaction contract, not a claim that arbitrary manual writes are safe.

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

`validate` checks the pinned Node version, typechecks, builds, runs unit/integration tests, rejects failures/skips/cancellations/todos and executes three expected-failure mutation controls. Output is `.local/results/<timestamp-uuid>/`: source hashes, runtime, exact commands, positive TAP transcript, PostgreSQL backend/process evidence and negative-control logs. Source drift during the gate fails it. Test counts include the integration parent test; see the retained TAP for individual assertions/scenarios.

Tests start independent API child processes, not Fastify injection. Eight identical requests are held at a real PostgreSQL table lock until all eight backend sessions are observed blocked in INSERT, then released together. Exactly one must return 202, seven 200, with one run, two initial steps and one event. A two-request conflicting race must return one 202 and one 409. This proves finite races on one host, not load capacity or strict FIFO fairness.

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

The API binds **127.0.0.1** only, defaults to port 8080 (`PORT=0` selects an available port), and requires `OPERATOR_TOKEN` of at least 32 characters. Never commit tokens or connection strings. Migrations are explicit, not run automatically by the API. Startup fails if the workflow table is unavailable. `/healthz` is liveness only; it does not promise database readiness during an outage. This configuration is not a public-ready authenticated service; no TLS, tenant management or channel/tool authorization is supplied.

From a second terminal with the same private operator token:

```sh
curl -i http://127.0.0.1:8080/runs \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-incident-1' \
  --data '{"workflow":"incident-triage","version":1,"input":{"title":"Café incident","severity":"high"}}'
```

First response: HTTP **202**, `{run_id, state:"QUEUED", replayed:false}`, plus `Location: /runs/<run_id>`. Repeating the same request returns **200**, the same `run_id`, and `replayed:true`. Change severity to `low` with the same key: **409** with `{"error":"idempotency_conflict"}`. Use a new key for a genuinely new request, not to bypass uncertainty after an interrupted response.

`GET /runs/<run_id>` with the same Authorization header returns workflow/version/definition hash, original input, state, creation time and ordered steps. Unknown IDs return 404. Invalid requests return 400, oversized/unsupported payloads 413/415, missing/bad authorization 401. Storage or unexpected server failures return generic 503 without SQL, inputs or credentials. If the response was lost around COMMIT, retry the original key/input; do not assume the transaction failed.

## Boundaries

- PostgreSQL durability depends on its storage and configuration. Tests keep `fsync` and `synchronous_commit` enabled and check normal same-directory database restart. They do not simulate power loss, disk loss, replication failover or arbitrary crash safety.
- Duplicate **attempts** are possible; one run identity under the validated key scope is not exactly-once workflow execution.
- No run deletion/idempotency expiry API exists in DAW-1. Retention and archival policies remain unspecified; manual deletion would change replay behavior.
- The table index prepares future work selection. No worker claims, leases, retries, scheduler loop, agent, LLM, tools, approvals, cancellations or external effects are implemented.
- No HTTP load benchmark, latency SLO, production traffic, provider integration or production AI experience is established.

## Layout

`src/domain/` holds the deterministic definition and fingerprint; `src/application/` the transaction use case; `src/persistence/` PostgreSQL and migrations; `src/http.ts` the HTTP boundary; `src/entrypoints/` API/migration commands. `tests/` contains pure contracts and real infrastructure scenarios; `tests/fixtures/` contains explicit test-only source mutations. `scripts/` drives reproducible validation. `docs/evidence/` retains selected reviewed output; routine artifacts, dependencies and compiled output stay ignored.
