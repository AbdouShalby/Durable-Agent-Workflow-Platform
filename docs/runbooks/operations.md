# DAW-6 operational runbook

For a trusted local production-inspired lab only. Use the README's dedicated PostgreSQL and private runtime configuration; do not test against a shared service or sensitive incident data.

## Observe before intervening

```sh
curl -i http://127.0.0.1:8080/healthz
curl -i http://127.0.0.1:8080/readyz
curl --fail http://127.0.0.1:8080/operations -H "Authorization: Bearer $OPERATOR_TOKEN"
```

`healthz` means the API event loop can answer; it never queries PostgreSQL. `readyz` checks readable schema capabilities and the exact migration-name/checksum set loaded from this checkout. It returns 503 on dependency/schema error, drain or handler saturation. It does not certify constraints against arbitrary manual DDL, writable primary status, worker/scheduler progress, provider/LLM health or readiness of every future request. API and daemon startup fail closed if their initial schema probe fails; start them again after restoring dependencies. Migrations are explicit, never performed by a health request.

`operations` requires the operator credential (not the separate approver). It returns schema-versioned numeric gauges with a fixed set of names, not per-run labels. Empty history returns zeros. Connection/query failures return coarse 503; there is no stale cached success.

| Signal | Meaning / interpretation |
| --- | --- |
| ready_steps / oldest_ready_seconds | READY rows and nonnegative age since earliest available_at; not a scheduling fairness/SLO guarantee |
| live_leases / expired_leases | DB-time ownership rows; live lease does not prove the OS worker is alive |
| retry_wait_steps / due_retries | Persisted delayed/due retries; rising due backlog warrants checking the scheduler |
| recovered_attempts / retryable_attempts | Retained attempts retired as EXPIRED/RETRYABLE; not a count of ultimately successful recoveries |
| waiting_approval_runs / cancelled_runs | Durable human-control states |
| unknown_effects / reconciliation_runs | Possible external writes and parked runs requiring independent evidence |
| failed_runs / succeeded_runs | Current terminal-state totals, distinct from provider HTTP/receipt success |
| api_in_flight / api_pool_connections / api_pool_waiting | Executing handlers including this request, primary API pool size and waiting checkouts |

All counts are retained-row **gauges**, not forever-monotonic counters. Queries scan retained tables and have a 500ms server statement timeout in a separate two-connection pool (1s connection/acquisition timeout, 1.5s client query timeout). Large histories may make telemetry unavailable. No retention, capacity benchmark, scrape backend or automatic alerting system is included.

## PostgreSQL outage / recovery

1. Check liveness and readiness separately. Preserve the original idempotency key/input after any failed or disconnected admission; a lost response is not proof that COMMIT failed.
2. Restore the same dedicated database and committed data. Do not create a new empty database to make readiness green. Do not run destructive reset/clean/prune commands.
3. If startup failed, start API, worker and scheduler normally. Already-running daemons retry failed polls after 500ms; they do not turn DB errors into business failure or success. A checked-out client error is logged without killing the daemon; the failed query still rejects.
4. Confirm readiness, watch persisted retries/expired leases and role progress logs. The scheduler is required to recover due/expired work. A stale worker still must pass owner/fence/lease/deadline checks.
5. For UNKNOWN or RECONCILIATION_REQUIRED, inspect the saved intent/receipt and independent simulator evidence. Never create a new run/effect key, fabricate payment state, edit approvals or blindly resend to bypass uncertainty. No manual resolution/override endpoint is implemented.

The automated outage test stops only its owned PostgreSQL process, retains its data directory, and restarts it on the same port. It proves a representative service outage, not power loss, storage loss, a blackholed network, replication failover or arbitrary crash safety.

## Shutdown / restart

Send SIGTERM to the **specific owned API/worker/scheduler PID**, not a process-name wildcard. API stops new business handlers and drains responses/pools. Worker/scheduler stop polling and finish the current operation. Idle connections are closed. The shutdown controller emits `draining`, then `stopped` on cooperative completion.

After five seconds an event-loop timer emits `shutdown_deadline` and exits with code 1. Unfinished transactions/leases are not marked successful; an external request may already have executed. Restart against the same database, keep the scheduler running, and retry original HTTP identities. The tests separately cover API pre-INSERT forced exit and worker pre-completion forced exit; those windows do not prove that all disconnections imply rollback.

This timer is **not OS preemption**: synchronous event-loop blockage, SIGSTOP or host failure can delay it. An external supervisor must enforce any hard wall-clock termination policy; none is installed by this milestone. There is no drain guarantee for arbitrary plugins/user code.

## Resource and telemetry boundaries

- Maximum 32 simultaneously executing API handlers. Overflow is 503 before a handler enters. This is after authentication/parsing/validation, not a socket, body-parser or process-memory cap. Liveness bypasses it; readiness may report overload. Retrying clients must use backoff and retain request identities.
- HTTP body limit remains 16KiB; receive/inactivity/keepalive timeouts are 5s. A receive timeout is not an application transaction deadline. Primary pools stay at 16 connections per process; each API also has the two probe connections. Total deployment resources depend on process/connection counts.
- Existing attempt, lease, retry, per-step elapsed, agent-turn/call/tool/estimated-cost budgets are unchanged. Poll retry delay is separate from durable business retry policy. Startup and resource checks are not production capacity proof.
- Structured `attempt_span` records use the durable run identity as trace_id, a fresh span_id, step/attempt/fence, phase, outcome and elapsed duration. IDs belong to correlation logs, **never metric labels**. Payloads, model output, credentials, raw exceptions and URLs are omitted. A kill may leave a start without an end; logs can be lost. Join run/step/attempt to the durable journal when investigating.
- `poll_progress` identifies worker or scheduler progress, `poll_failed` an infrastructure failure, and `database-client-error` / `database-pool-error` / `probe_pool_error` connection failures. There are no per-owner metric series. No OpenTelemetry exporter, inbound traceparent handling, external-service span propagation or trace storage is claimed.

## Reproduce all evidence

Use pinned Node 24.20.0 and real PostgreSQL binaries as a non-root Linux/WSL user:

```sh
npm ci --ignore-scripts
npm run validate
```

For focused diagnostics (not a replacement for the full gate):

```sh
npm run build
node --test dist/tests/operations.test.js
npm run test:secrets
```

Set `PG_BIN` only to the installed PostgreSQL binary directory. If the OS temporary filesystem is full, set `TMPDIR` to a writable dedicated directory with space; keep previous evidence/cluster data intact. Tests ignore DATABASE_URL for selecting their clusters, stop only owned PIDs and retain the clusters. `.local/results/<run>/summary.json` binds source hashes and all infrastructure manifests; `operations.json` contains cases, PostgreSQL/role PIDs, exit status, snapshots and span witnesses. Negative-control subdirectories hold the expected-failure logs. Missing infrastructure, skipped tests, selected-case mutation settings or source drift fail the full gate.

The gate bounds independent test-file groups to one at a time, retaining all real simultaneous actors/requests inside each concurrency scenario. If startup times out, inspect the failed run, process exits and original fixture failure before changing application policy. Effect/approval evidence keeps the original error separately from cleanup failures; neither is suppressed. Host scheduling/filesystem contention is not a workflow retry-policy failure, and a rerun is not evidence that a failed gate passed.

### Windows-mounted source versus native Linux validation

Windows-mounted WSL paths can make module loading exceed the unchanged startup deadlines. Prefer a native Linux filesystem for validation instead of raising workflow/test limits. To test an uncommitted snapshot without creating another Git repository, use the existing index read-only and copy only tracked/nonignored files. Run with pinned Node already on PATH:

```sh
DAW_SOURCE_ROOT="$(pwd)"
DAW_SOURCE_GIT="$(git rev-parse --absolute-git-dir)"
DAW_SNAPSHOT="$(mktemp -d /var/tmp/daw6-verify-XXXXXXXX)"
git ls-files -z --cached --others --exclude-standard | sort -zu |
  tar --null -T - -cf - | tar -xf - -C "$DAW_SNAPSHOT"
(
  cd "$DAW_SNAPSHOT" || exit 1
  export GIT_DIR="$DAW_SOURCE_GIT" GIT_WORK_TREE="$DAW_SNAPSHOT" GIT_OPTIONAL_LOCKS=0
  npm ci --ignore-scripts && npm run validate
)
```

This does not run git init/clone, change the original index or publish anything. Keep the source fixed and compare every `sourceSha256` entry from the resulting summary against the original checkout before accepting/committing it. Curate artifacts byte-for-byte; do not claim a native result validates Windows filesystem startup latency. The temporary snapshot and owned test clusters are retained, not deleted by these commands.
