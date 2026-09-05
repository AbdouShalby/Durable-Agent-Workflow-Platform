# DAW-3: external effects and conservative reconciliation

## Audit and plan

Baseline: published DAW-2 `8901a8559fa21a9d545da104d0998539db43b11d`, clean
`main` tracking `origin/main`. DAW-1 is its parent `7fd5ff3`; DAW-0 is the design
baseline, not a separate repository commit. The approved design is reflected in ADRs 0001/0002 and historical
milestone records. The explicit DAW-3 request narrows this checkpoint to external
effects, not an agent/tool marketplace or approval system. Published DAW-2 CI was
observed successful during this audit; a future DAW-3 CI result is not assumed.

Plan: (1) preserve v1/migrations; (2) atomically admit v2 with durable intent;
(3) persist uncertainty before networking; (4) bind receipts and enforce current
ownership; (5) reconcile with contract-aware bounded retries; (6) test against
independent HTTP and PostgreSQL processes with real failure windows and mutations;
(7) review source/claims, retain final evidence, sign off and create one commit.

## Implementation boundary

See [ADR 0003](adr/0003-external-effect-uncertainty.md) for state transitions,
assumptions and limitations, and the [README demo](../README.md#external-effect-demo-v2-only).
Admission has one platform transaction; the independent service has its own
database transactions. External writes survive platform rollback. Stable effect
keys do not contain attempt or fence. UNKNOWN never means an invented failed
external payment/write. The simulator is not a real customer service.

## Validation and review

Final clean-install gate, **2026-09-05**, `npm ci --ignore-scripts` followed by
`npm run validate`:

- **48 passed, zero failed/skipped/cancelled/todo**: the original 30 DAW-1/2 tests,
  one receipt/identity unit test, 16 external-effect scenarios and their integration parent.
- **12 negative controls detected** at the intended assertions: original three
  admission and five execution controls, plus four external-effect controls.
  Their expected exit-1 results are successful regression checks, not positive failures.
- Node **24.20.0**, PostgreSQL **18.6**, Linux/WSL2; separate platform/provider
  clusters with `fsync=on` and `synchronous_commit=on`. Positive TAP duration
  **113.50 seconds**, full gate **351.11 seconds**; neither is a capacity benchmark.
- **44 source/config/test hashes** match the tested candidate. No source changed
  during validation. Root transcript and all three observation documents match
  the manifest checksums. Historical migrations 001/002, lockfile and DAW-1/2
  curated evidence are unchanged. The one updated original-test assertion explicitly
  expects migration 003 in addition to 001/002; no earlier assertion was removed.
- Effect observations record **33 owned processes**, all with recorded exits.
  Eight provider SQL sessions are observed simultaneously blocked before release,
  independently from eight v2 HTTP admission sessions in a separate case.
- Clean dependency installation reported zero known npm vulnerabilities at that
  time; this is not a security certification. A narrow offline token/private-key/
  publishable-env scan found no matches; it is not a comprehensive vendor scan.

An earlier gate correctly failed when the host's tmpfs `/tmp` filled during initdb;
that prerequisite failure was **not** counted as a detected mutation. No existing
clusters/data were deleted. A new owned directory on disk-backed `/var/tmp` was
used via `TMPDIR`, and the entire gate was rerun. Its exact temporary root is in
the final manifest. For reproduction on a space-constrained Linux host, set
`TMPDIR` to a writable directory with sufficient disk space; no global setting is
changed by the runner. Exploratory runs remain ignored under `.local/results/`.

### Evidence index

All 32 final artifacts are retained under [evidence/daw-3](evidence/daw-3/summary.json).
They are unmodified runner output; observation files are not standalone pass verdicts.

| Evidence | What it establishes |
|---|---|
| [Summary](evidence/daw-3/summary.json), [transcript](evidence/daw-3/validation.log) | Exact gate status, commands, runtime, source hashes, positive TAP and control outcomes |
| [Effect observations](evidence/daw-3/effects.json) | Independent stores/PIDs, simultaneous SQL sessions, durable intents, receipts, actual writes versus GET/POST attempts and cleanup |
| [Admission](evidence/daw-3/integration.json), [execution](evidence/daw-3/execution.json) | Preserved DAW-1/2 finite concurrency/recovery behavior |
| [Admission controls](evidence/daw-3/negative-controls.json), [execution controls](evidence/daw-3/execution-negative-controls.json) | Eight original expected failing assertions; sibling per-mode directories retain raw logs/observations |
| [Effect controls](evidence/daw-3/effect-negative-controls.json) | Four new named witnesses and expected exits |
| [Key control](evidence/daw-3/effect-effect-key/tests.log), [timeout control](evidence/daw-3/effect-timeout/tests.log) | Removing provider key uniqueness or durable pre-send UNKNOWN is detected |
| [Verification control](evidence/daw-3/effect-verification/tests.log), [unkeyed control](evidence/daw-3/effect-unkeyed/tests.log) | Blind resend after unavailable lookup or removal of unkeyed reconciliation safeguards is detected |

The key contract race has eight concurrent POSTs, one conflicting POST and a
subsequent platform POST: ten requests but **one** external write. The SIGKILL-
before-receipt case has **one POST, one GET, one write**. The timeout plus failed
lookup case has **one POST, two GETs, one write**. Unkeyed ambiguity has **one POST,
zero GETs, one write** and remains UNKNOWN. The saved-receipt SIGKILL case completes
with the provider stopped and **no additional request**. Only the verified-not-found
keyed case resends: POST, GET, POST, with the same logical effect key and one write.

The initial gate's `gitBase` is DAW-2, not an invented future commit. Source hashes
identify the precommit tested candidate. Node assertion whitespace is preserved by
the twelve exact `.gitattributes` log exceptions; source diagnostics are unchanged.

### Standards review

The independent read-only Standards review identified a P2: preparation database
errors could be treated as permanent execution failures. A separate infrastructure
error now leaves the lease for reconciliation, while invalid durable intent remains
a permanent domain error. A real trigger-failure witness verifies rolled-back
PREPARED intent, no external requests and successful later lease recovery. Follow-up
review reports no unresolved concrete findings.

### Spec review

The independent read-only Spec review requested direct witnesses for a crash after
receipt persistence and deadline-driven parking. Tests now SIGKILL an actual worker
after VERIFIED persistence, stop the provider and complete from the saved receipt
without another request. DB-time deadline tests cover UNKNOWN in RETRY_WAIT and
READY, and VERIFIED with unfinished bookkeeping. Follow-up review reports no
unresolved concrete findings. These reviews complement, not replace, the final gate.

### Sign-off and commit boundary

**DAW-3 signed off as production-inspired external-effect/reconciliation evidence.**
Standards: zero unresolved findings. Spec: zero unresolved findings. The checkpoint
contains only the scoped schema/domain/execution/simulator changes, tests, validation
wiring, documentation and final evidence. No real external customer service is used.
Runtime outputs, dependency directories, downloaded Node, compiled files and temporary
clusters are not committed. This milestone creates one local commit; publication is
a separate checkpoint. No application source changed after the final validation gate.

## Explicit limitations

This is a production-inspired showcase, not production-proven recovery or exactly-once
execution. A lease cannot retract a dispatched HTTP write. Deduplication depends on
the provider's durable key/fingerprint contract and retention; receipt verification
depends on truthful provider responses and stable service identity. There is no
physical storage-loss, cross-region failover, hostile worker or malicious provider
proof. Unkeyed ambiguity and exhausted reconciliation stay parked for human
investigation. No blind retry, manual override, agent, LLM or approval workflow is
added. DAW-4 through DAW-7 remain unstarted. Other portfolio repositories are untouched.
