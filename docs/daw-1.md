# DAW-1: durable foundation

## Audit

The approved DAW-0 conversation is the source of truth: strict TypeScript, Node LTS, PostgreSQL-backed durable admission, a deterministic versioned workflow and no worker/agent/external effects yet. The target directory did not exist and its parent was not a Git repository. No pre-existing changes were overwritten. A new local repository was initialized on `codex/daw-1`; there was no baseline commit or remote.

Docker Desktop's Linux daemon was unavailable. No recovery action was attempted. Existing PostgreSQL/Redis services inside WSL were left untouched. Tests instead use PostgreSQL executables to initialize a new temporary cluster owned by the non-root test user, on an available loopback port.

## Plan and implemented boundary

1. Pin Node 24.20.0; strict TypeScript with unchecked-index and optional-property checks, no emission on compiler errors; exact dependency lock.
2. Add a transactional/checksummed migration for workflow runs, initial steps and creation events.
3. Define deterministic incident-triage v1 pure steps without creating an executor.
4. Implement local operator HTTP admission/read endpoints and canonical fingerprint checks backed by database uniqueness.
5. Prove simultaneous admission, conflicts, full rollback, persistence, and rejection of malformed inputs using real processes/PostgreSQL.
6. Run deliberate source mutations to establish regression sensitivity, review source and claims, then create one scoped checkpoint.

## Test design and limitations

- Eight independent PostgreSQL sessions, fed by two separate HTTP server processes, reach INSERT while held by a test-owned table lock; their release creates a real concurrent unique-key race. Expected result: one 202, seven 200, one run/two steps/one event. The table barrier is test-only and does not alter application SQL or introduce an application lock.
- A conflicting two-request race expects one 202/one 409; subsequent retries preserve the winning parameters.
- Database trigger exceptions at scheduling and event insertion must roll back all earlier writes. The same key must subsequently succeed; a failed transaction cannot consume it.
- API SIGKILL/restart and PostgreSQL normal shutdown/restart reuse the same persisted run. This is persistence evidence, not expired-lease recovery or power-loss testing.
- Concurrent migration runners serialize. Applied checksum drift is rejected; a failing migration leaves neither partial schema nor history.
- Negative controls change only loaded test processes: unconditional 202, disabled fingerprint comparison and COMMIT before scheduling must each fail the appropriate integration assertion. Positive tests have no mutation preload.

Type errors found during the first implementation pass were corrected through explicit narrowing, not non-null assertions or relaxed compiler settings. Early exploratory outputs remain ignored, not substituted for final evidence.

## Validation, review and sign-off

Final local gate, 2026-09-05, after `npm ci --ignore-scripts`:

- **15 passed, 0 failed/skipped/cancelled/todo**: three unit tests, eleven real-infrastructure subtests and their integration parent. Positive test-runner time: 15.70 seconds. The full gate, including compiler passes and all negative controls, took approximately 65.48 seconds; this is execution evidence, not a throughput benchmark.
- **Three negative controls detected**: unconditional 202, disabled fingerprint comparison and a premature COMMIT each exited 1 at the intended regression-sensitive assertion. Their expected failures are not failed positive tests.
- Node **24.20.0**, PostgreSQL **18.6**, Linux/WSL2 x64. Exact application/dev dependencies are in `package.json` and `package-lock.json`. PostgreSQL ran with `fsync=on` and `synchronous_commit=on` in each owned cluster. CI's PostgreSQL 16 configuration has not been observed running remotely.
- An explicit `PG_BIN=/nonexistent/daw1-postgres npm run validate` probe failed with `initdb ENOENT`, exit 1 and zero skips; unavailable infrastructure does not produce a false pass.
- `docker compose config --quiet` passed using a temporary syntax-check password. Docker startup/container behavior was not tested. `npm audit` reported zero known vulnerabilities at the audit time; this is not a full security audit or a permanent guarantee.

### Retained evidence

| Artifact | Purpose |
|---|---|
| [Summary](evidence/daw-1/summary.json) | Status, exact commands, runtime, 23 source/config/test hashes and log checksums |
| [Validation transcript](evidence/daw-1/validation.log) | Positive TAP and successful negative-control detection output |
| [Integration observations](evidence/daw-1/integration.json) | Eight concurrent backend PIDs, two API PIDs, response identities/statuses, database durability settings and owned-process exits |
| [Negative-control summary](evidence/daw-1/negative-controls.json) | Expected failing assertion and exit code per mutation |
| [Status mutation](evidence/daw-1/status/tests.log), [observations](evidence/daw-1/status/integration.json) | Unconditional creation status is rejected |
| [Fingerprint mutation](evidence/daw-1/fingerprint/tests.log), [observations](evidence/daw-1/fingerprint/integration.json) | Accepting a conflicting intended request is rejected |
| [Atomicity mutation](evidence/daw-1/atomicity/tests.log), [observations](evidence/daw-1/atomicity/integration.json) | Committing before scheduling leaves partial state and fails the rollback test |
| [Missing PostgreSQL summary](evidence/daw-1/missing-postgres/summary.json), [transcript](evidence/daw-1/missing-postgres/validation.log), [observations](evidence/daw-1/missing-postgres/integration.json) | Explicit expected prerequisite failure; not positive runtime evidence |

`gitBase: null` is intentional: this is the first commit and the tests preceded it. The exact normalized source hashes identify the tested candidate; evidence does not invent its own future commit hash. `integration.json` is an observations document, not an independent pass verdict: consult the enclosing summary and TAP, particularly for deliberately mutated runs. Historic exploratory attempts remain ignored in `.local/results/`.

The three negative-control TAP logs retain Node's original indented blank lines. `.gitattributes` disables only end-of-line whitespace diagnostics for those three exact artifact paths; application/test source checks are unchanged. The evidence was not reformatted to pass a source-style check.

### Standards review

Independent read-only review found no blocking violations. Its optional cleanup finding was resolved: all owned child processes are attempted even when one stop fails, and teardown retains evidence before reporting aggregated errors. A separate configuration review also replaced native malformed-URL errors with a fixed credential-safe message and added a regression test. The final follow-up review has no unresolved concerns.

### Spec review

Independent read-only review confirmed the DAW-1 scope, atomic creation/scheduling, real concurrency, replay/conflict behavior and honest persistence limitations. No workers, claim/lease/retry loop, agents, LLM or external-effect features were added. Final follow-up review found no new blocker.

### Sign-off and commit boundary

**DAW-1 signed off as a durable-admission foundation**, not a functioning agent/execution platform. Selected evidence is retained; temporary clusters, downloaded tooling, dependency directories, compiled output and ordinary logs remain uncommitted. No existing repository, Career Ops file or shared database was modified. No remote repository or push was created. The initial checkpoint contains this project's source/configuration/tests/documentation only, plus the explicitly curated evidence.

Next eligible milestone is DAW-2, but it is **not started** and is not authorized by this checkpoint. No human decision is required to close DAW-1.

## Exact initial checkpoint files

All 42 files below are new DAW-1 work; no historical user changes are mixed in:

```text
.gitattributes
.github/workflows/ci.yml
.gitignore
.npmrc
.nvmrc
CONTEXT.md
README.md
compose.yml
docs/adr/0001-postgres-admission.md
docs/daw-1.md
docs/evidence/daw-1/summary.json
docs/evidence/daw-1/validation.log
docs/evidence/daw-1/integration.json
docs/evidence/daw-1/negative-controls.json
docs/evidence/daw-1/status/integration.json
docs/evidence/daw-1/status/tests.log
docs/evidence/daw-1/fingerprint/integration.json
docs/evidence/daw-1/fingerprint/tests.log
docs/evidence/daw-1/atomicity/integration.json
docs/evidence/daw-1/atomicity/tests.log
docs/evidence/daw-1/missing-postgres/summary.json
docs/evidence/daw-1/missing-postgres/validation.log
docs/evidence/daw-1/missing-postgres/integration.json
migrations/001_foundation.sql
package-lock.json
package.json
scripts/check-node.mjs
scripts/negative-controls.mjs
scripts/validate.mjs
src/application/runs.ts
src/config.ts
src/domain/workflow.ts
src/entrypoints/api.ts
src/entrypoints/migrate.ts
src/http.ts
src/persistence/database.ts
src/persistence/migrations.ts
tests/fixtures/regression.mjs
tests/integration.test.ts
tests/support/lab.ts
tests/unit.test.ts
tsconfig.json
```
