# DAW-5: human control and governed approvals

Baseline: published `f1fbf2b3fbd944a38f56b4c77612eb5c03f73bd3`. The approved DAW-0 design and the explicit DAW-5 request define this milestone. This is a production-inspired showcase, not a production authorization or payment system.

## Audit and implementation boundary

The baseline working tree was clean. DAW-1/2 admission and execution, DAW-3 independent simulator reconciliation, and DAW-4 accepted model checkpoints were present and published. No approval or cancellation API existed. V1/v2/v3 definition objects and historical migration files remain unchanged. V4 composes existing capabilities; it does not add a new external tool or give an agent write access.

`incident-triage` v4 runs normalize-incident, build-summary, analyze-incident, then the existing **keyed write-summary simulator**. The engine derives the exact write from the accepted agent summary, limited to the existing provider contract's 300 characters. Longer v4 proposals fail without preparing an external invocation or approval; v3 retains its previous output contract.

The pinned `summary-review-v1` policy requires a human for high severity; low severity proceeds without an approval record. This is an explicit synthetic policy demonstration, not a fraud/risk classifier. Caller-supplied policy, approval, tool or target overrides are rejected. Admission saves the version, agent session, fixed policy and operator-configured loopback target atomically. Agent completion then atomically saves its step result, prepares the action and either schedules the write or records WAITING_APPROVAL. No network call spans a platform transaction.

## Durable state and authorization

An approval has its own UUID and is bound to run, step, tool, effect key, keyed contract, target service identity/origin, exact request and request fingerprint, policy version/fingerprint, and database expiry. Its default validity is five minutes. The human echoes the displayed action and policy digests; the engine recomputes them independently before the decision and every dispatch. No endpoint edits action parameters, policy or expiry. The changed-action/policy tests use controlled SQL fault injection to prove stale grants cannot be rebound; manual DB editing is not a supported workflow-management interface.

Approval states: PENDING, APPROVED, REJECTED, EXPIRED, INVALIDATED, CANCELLED. Actor, decision time, initial authorization time and related events are durable. A decision is not execution. The engine separately checks the approved human identity, full binding and live expiry before authorizing an outbound POST. Duplicate acceptance returns the same logical decision without another scheduling event. Duplicate rejection is harmless. Opposite, stale, rejected, invalidated or cancelled decisions cannot reopen work. Completed runs are not mutated by stale approval submissions.

Waiting holds no worker lease or attempt for the write step, whose execution deadline starts on its first claim. API/worker restart does not lose the pending approval or regenerate accepted agent decisions. The existing scheduler expires pending or approved-but-not-yet-authorized approvals using database time and persists failure. Attempt/backoff/deadline limits remain unchanged after dispatch.

Expired approval is not permission to resend. For a previously authorized uncertain effect, receipt GET may still verify the exact saved operation after expiry; a verified receipt can complete bookkeeping without another POST. If lookup returns not-found after expiry, a new send is blocked and the run parks for reconciliation. Expiry or cancellation after the authorization linearization point cannot retract already authorized/in-flight network work.

## Human capability boundary

The API takes a separate optional `APPROVER_TOKEN`, at least 32 characters and different from `OPERATOR_TOKEN`. Missing configuration denies approval instead of falling back to the operator credential. Both values are private runtime configuration; examples generate them, never embed literals. The human principal is derived from authentication, not a body field or model response. Application decision functions additionally require the human principal; the dispatch engine requires its durable decision. This is local capability separation, not multi-tenant RBAC, hardware-backed human identity or proof a person physically approved.

| Capability | Operator token | Approver token | Agent |
| --- | --- | --- | --- |
| Create run / cancel v4 | Yes | No | No |
| Read run and exact approval action preview | Yes | Yes | No HTTP capability |
| Approve or reject displayed action | No | Yes | No |
| Write approval/workflow records directly | No API | No API | No database/tool capability |

The approver's read-only GET includes full durable action parameters, target, effect key, policy, fingerprints, approval identity and expiry. It can be recomputed without DB access or borrowing an operator credential. Agents retain only the two read-only local tools, never the approval service, arbitrary URLs, shell or SQL. Production worker deployment must not supply operator/approver credentials to the model or tools. Tests start child workers without those credentials. Trusted application code and DB ownership remain assumptions: there is no hostile-process sandbox or separate database-role design in this milestone.

## Cancellation linearization

Cancellation is introduced for v4 only, under the same run-before-step locks used by execution and approval. It closes active attempts and clears ownership atomically, so an old worker cannot commit, renew or authorize another send.

| State when cancellation owns the run lock | Result |
| --- | --- |
| No invocation yet, waiting for approval, or PREPARED | CANCELLED; future work forbidden, no external send was authorized |
| UNKNOWN or VERIFIED effect | RECONCILIATION_REQUIRED; receipt/intent retained, previously authorized work may still finish externally |
| Already succeeded or failed | Conflict; terminal state unchanged |
| Previously cancelled/requested cancellation | Same durable result, replayed=true |

If cancellation wins before approval/dispatch, no later approval unblocks it. If approval wins first but dispatch has not been authorized, cancellation still prevents sending. If external authorization wins, the platform does not claim rollback or absence of side effects. Reconciliation stays parked for inspection; no compensation, override, resend or resolution endpoint is added. Do not create a new key/run to bypass unresolved external uncertainty.

## Reproduce locally

Use the README's pinned Node, dedicated PostgreSQL, runtime-generated operator token, migrations and independent simulator setup. Generate a separate token privately before starting the API (POSIX example):

```sh
export APPROVER_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
```

Create using the operator's existing authentication/idempotency headers:

```json
{"workflow":"incident-triage","version":4,"input":{"title":"Synthetic governed incident","severity":"high"}}
```

Run worker and scheduler. GET `/runs/<run_id>` with either permitted token. Review `approval_action` in full and `approval.expires_at`, then POST `/runs/<run_id>/approvals/<approval_id>` with the approver token and:

```json
{"decision":"approve","action_fingerprint":"<displayed action digest>","policy_fingerprint":"<displayed policy digest>"}
```

Use `reject` for rejection. Digests must be the actual 64-character lowercase hex values, not these documentation placeholders. First decision and exact replay return 200 with `replayed`; unusable/opposite bindings return 409, unknown run/approval 404, forbidden approver capability 403, malformed body 400. POST `/runs/<run_id>/cancel` with the operator token and `{}` returns the durable cancellation/reconciliation state, or 409 for unsupported/terminal work. Approval requests never execute HTTP effects themselves.

For the policy bypass demonstration, submit a **different** idempotency key with severity low: the engine executes the existing keyed action without creating an approval. The default deterministic model requires no paid service. No live LLM call is claimed.

```sh
npm ci --ignore-scripts
npm run validate
```

Tests require real PostgreSQL/Linux or WSL, create isolated platform and provider clusters, and execute real APIs, workers, lock contention and process failures. No SQLite, fake queue or sequential replacement for the concurrency witnesses. All sixteen prior mutations remain, with four new controls for approval binding, expiry, engine principal and cancellation classification. Positive validation forbids case-selection/mutation/live-model settings. Routine artifacts and retained test clusters are ignored; no data is deleted.

The approval race holds eight live HTTP transactions behind a PostgreSQL run-row lock and observes all eight blocked backends before releasing them. Exactly one response is non-replay, with one decision event; four actual worker processes then produce one write attempt, one provider POST and one external write. A separate two-request barrier covers approval versus cancellation; controlled before/after-dispatch windows cover claimed-worker fencing and cancellation after a committed external write. These are finite, reproducible single-host races, not a load or all-interleavings proof.

Expiry tests shift only the owned test records' timestamps into the past, then execute the real database-time comparison and recovery functions. They do not wait five minutes or substitute an in-memory clock. The waiting-restart test restarts API/worker processes while retaining PostgreSQL; prior milestones separately cover database restart. The insertion-failure trigger proves action/approval scheduling rolls back with agent-step completion and resumes from accepted decisions without a new model call.

The four new mutations independently remove action-digest equality, pre-dispatch expiry enforcement, the engine's human-principal check, or conservative post-authorization cancellation classification. Each must fail its named witness; they do not establish exhaustive mutation coverage or defeat of hostile code with database access.

## Review and evidence

**DAW-5 signed off locally as a production-inspired governed-approval showcase on 2026-09-06.** The fixed-source gate ran from `2026-09-05T21:56:05.440Z` to `22:05:47.190Z` (UTC), against baseline `f1fbf2b3fbd944a38f56b4c77612eb5c03f73bd3`. All **94** positive tests passed with zero failures, skips, cancellations or todos; counts include integration parent tests. All **20** expected-failure mutations failed their named witnesses as required. The four offline credential-guard tests passed. No earlier test or mutation was removed or weakened.

Runtime: pinned Node `v24.20.0`, Linux x64/WSL2, real PostgreSQL **18.6**, with `fsync` and `synchronous_commit` enabled. The owned temporary root `REDACTED_LOCAL_ROOT_021` avoids the full default temporary filesystem; no old cluster or data was deleted. The gate records **61 source/config/test hashes**, verifies no source drift, and binds all five infrastructure manifests plus its raw transcript by SHA-256. Every source hash and artifact binding was independently rechecked before curation. No application/test/validation source changed after the gate.

All **50** curated artifacts were copied byte-for-byte and compared with the final run. The post-curation credential guard passed across **239 files with zero findings**; this is a bounded offline hygiene scan, not proof no possible secret pattern exists. Twenty exact `.gitattributes` log exceptions retain raw assertion whitespace without changing source diagnostics. Historical milestone evidence and migrations remain unchanged. The dependency lockfile and independent simulator implementation are unchanged.

| Evidence | What it establishes |
| --- | --- |
| [Summary](evidence/daw-5/summary.json), [raw transcript](evidence/daw-5/validation.log) | Exact commands, runtime, 94 positive tests, 20 mutation verdicts and source hashes |
| [Approval journal](evidence/daw-5/approvals.json) | Nineteen PostgreSQL cases, full approval/action/event outcomes, two distinct clusters, eight blocked approval backends, one POST/write, and recorded exits for 33 runtime processes plus 21 APIs |
| [Admission](evidence/daw-5/integration.json), [execution](evidence/daw-5/execution.json) | Earlier idempotency, transaction, lease, fencing and recovery witnesses preserved |
| [External effects](evidence/daw-5/effects.json), [agents](evidence/daw-5/agent.json) | Independent effect persistence/uncertainty and accepted-agent checkpoint/budget witnesses preserved |
| [Admission mutations](evidence/daw-5/negative-controls.json), [execution mutations](evidence/daw-5/execution-negative-controls.json), [effect mutations](evidence/daw-5/effect-negative-controls.json), [agent mutations](evidence/daw-5/agent-negative-controls.json) | All sixteen prior controls retained; sibling directories contain their raw evidence |
| [Approval mutation summary](evidence/daw-5/approval-negative-controls.json) | Four named new controls and expected failing exits |
| [Action fingerprint](evidence/daw-5/approval-fingerprint/tests.log), [expiry](evidence/daw-5/approval-expiry/tests.log) | A changed transaction or expired grant cannot become an authorized write; removing the corresponding guard is detected |
| [Human authorization](evidence/daw-5/approval-authorization/tests.log), [cancellation](evidence/daw-5/approval-cancellation/tests.log) | Removing engine principal enforcement or pretending post-write cancellation rolls back is detected |

### Standards review

Two initial findings: approvers lacked the full reviewable action/target preview, and failed barrier rollback could bypass client release and pending-request cleanup. The human GET now exposes the complete action and policy; nested cleanup releases the connection and settles pending requests even if rollback fails. Follow-up and final-delta source reviews: **zero unresolved findings**. Reviewers did not run tests; the full validation gate supplies execution evidence.

### Spec review

One initial finding: the approver could not independently retrieve/recompute the full proposed action without borrowing operator access. The separate approver credential can now read the run/action preview, with an integration assertion recomputing the displayed fingerprint. Follow-up and final-delta source reviews: **zero unresolved findings**. No approval editing/reproposal, uncertainty override or new external tool was introduced.

### Commit boundary and limitations

This checkpoint contains only the additive v4 approval schema/rules, engine/HTTP integration, real infrastructure and mutation tests, CI wiring, documentation and curated evidence. Private runtime configuration, compiled output, dependencies, routine results and retained clusters remain ignored. The full existing gate ran on the same source that is committed; documentation/evidence curation does not change application behavior.

No DAW-6/7 work, new write-capable tool, multi-agent runtime, browser/code execution or changes to other portfolio repositories are included. This is one local commit, **not publication or a GitHub CI result for this candidate**. No live LLM was called. Identity isolation against hostile workers/DB owners, real provider/customer payments, production traffic, universal race coverage and arbitrary crash safety are not proven. Human approval does not establish that a model summary is true, and cannot undo an already authorized external write.
