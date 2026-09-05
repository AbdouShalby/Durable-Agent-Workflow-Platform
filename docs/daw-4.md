# DAW-4: bounded read-only agent execution

Scope baseline: published `79dbdbb`. Source of truth: approved DAW-0 design from the portfolio task and completed DAW-1/2/3 source. This milestone introduces no human approvals, write-capable agent tools, browser/shell execution, arbitrary endpoints or multi-agent runtime. DAW-3 v2 external writes remain an explicitly separate workflow, not an agent capability.

## Acceptance and implementation

1. New `incident-triage` v3 performs the existing pure normalization/summary steps and one checkpointed `analyze-incident` step. Prior definition hashes/fingerprints stay unchanged.
2. Admission atomically saves the v3 session and trusted fixed policy alongside run/steps/event. The model adapter is selected by the operator at admission and persisted, not chosen by the request/model or silently changed on retry.
3. Each model call reserves a durable call number and estimated cost **before** dispatch. Missing responses keep the reservation. Each accepted decision and its event commit together, then its read-only tool observation is saved independently under the same lease/fencing discipline. No transaction covers network execution.
4. The strict schema rejects additional fields, coercions, unsupported kinds and oversized/malformed output. Separate policy rules reject unregistered tools, invalid per-tool inputs, invalid finish shape and nonexistent/duplicate evidence references. No repair loop is hidden: rejected proposals fail permanently; transport uncertainty may retry under existing bounded execution policy.
5. Resume reads accepted decisions and observations. Accepted model decisions are not regenerated. A read interrupted before its observation is saved may repeat because it is read-only; its execution budget reservation remains. Missing model responses can be called again with another cost reservation. No exactly-once provider billing claim is made.
6. A finish proposal is not success. Engine completion checks the accepted persisted finish/result under ownership locks before atomically completing the step/run.

## Fixed engine policy

| Bound | Value / enforcement |
| --- | --- |
| Accepted turns | At most 4 per session |
| Model calls, including lost responses | At most 5, also constrained by the cost budget |
| Read-only tool execution reservations | At most 3, including interrupted executions |
| Estimated cost ledger | 10,000 micro-USD reserved per call; 40,000 maximum; no refunds |
| Elapsed execution | 30 seconds from first agent-step claim, persisted in the existing step deadline |
| Individual model call | At most 5 seconds and never beyond remaining step deadline |
| Context / accepted output / provider envelope | 8,192 / 4,096 / 65,536 bytes |
| Provider output cap | 512 output tokens |

The cost ledger enforces a fixed conservative **estimate**, not a provider invoice or account-wide spending limit. It does not trust model-reported cost. Real prices, tokenization and billing can change; an operator must validate the estimate before paid use. There is no refund on timeout/crash, nor any claim that abort cancels remote billing. Existing attempt limits, recovery scheduler and DB-time fencing continue to apply. A stale process may still perform bounded computation but cannot accept a decision/observation/result after ownership expires.

## Tools and model boundary

The private registry contains only `incident-context` (`topic: summary`) and `runbook` (`topic: guidance`). Both read synthetic/persisted input and fixed local guidance. They have no database handle, URL, shell or network capability. Explicit dispatch validates the per-tool input again before executing. No user-supplied plugins are loaded.

Schema-valid text is **not** proof of correct reasoning. Evidence IDs must refer to saved observations, but semantic entailment and general prompt-injection resistance are not established. The small evaluation dataset checks deterministic fixture behavior, not real model quality.

The default `deterministic` adapter emits one read proposal and then a finish using its saved observation. Its outputs depend only on the supplied context. Tests exercise failures through injected adapters, not a production fallback or mutable runtime policy.

`DAW_AGENT_ADAPTER=openai` at admission selects the isolated OpenAI Responses adapter. It fixes the HTTPS endpoint and model snapshot `gpt-4.1-mini-2025-04-14`, disables redirects/storage, requests strict structured output, and supplies no hosted tools. Set `OPENAI_API_KEY` privately in the worker environment; never place it in tracked files. Missing configuration fails without switching to the simulator. Do not use sensitive incident text in this showcase.

Contract sources: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Responses](https://developers.openai.com/api/reference/cli/resources/responses/methods/create), [model snapshot](https://developers.openai.com/api/docs/models/gpt-4.1-mini). The documentation connector was unavailable; official web documentation was used without changing global tooling. The HTTP adapter is exercised with a stub transport; **no live model call or paid provider verification is claimed**. Deterministic CI requires neither credentials nor provider access.

## Reproduce

Use the existing README runtime/PostgreSQL setup. Start API, worker and scheduler as before, then use the same authentication/idempotency headers with:

```json
{"workflow":"incident-triage","version":3,"input":{"title":"Synthetic incident","severity":"high"}}
```

Default execution performs no external LLM request and no external write. `GET /runs/<id>` includes the persisted `agent` session counters/limits and checkpoints. V1/v2 return `agent: null`. Model/backend/policy fields supplied in HTTP input are rejected.

```sh
npm ci --ignore-scripts
npm run validate
```

Full validation keeps all earlier admission/execution/effect tests and twelve earlier mutations, adds agent unit/evaluation and real PostgreSQL/worker tests, and adds four targeted mutations: output validation, tool allowlisting, checkpoint reuse after restart and turn-budget enforcement. No selected-case environment is permitted in the positive gate. Validation and direct agent integration tests reject a live `DAW_AGENT_ADAPTER` selection before starting work, preventing an inherited operator setting from making paid calls. Routine test clusters are isolated and retained; teardown stops only owned processes.

## Review and evidence

**DAW-4 signed off as a production-inspired bounded-agent showcase on 2026-09-06.** The final local gate ran from `2026-09-05T21:11:03Z` to `21:19:21Z` (UTC), against baseline `79dbdbb65e6af600fb21ef157547a5ab218300de`. All **71** positive tests passed, with zero failed, skipped, cancelled or todo tests; counts include integration parent tests. The four offline credential-guard tests passed and the working-tree guard reported zero findings across 140 files before evidence curation. All **16** expected-failure mutations were detected by their named regression witnesses. No existing test was removed or weakened.

Runtime: pinned Node `v24.20.0`, Linux x64 on WSL2, real PostgreSQL **18.6**, with `fsync` and `synchronous_commit` enabled. An isolated `TMPDIR=/var/tmp/daw4-validation-vFkGiHGF` was used because the default temporary filesystem was full; no existing clusters or data were deleted. The gate records **54 source/config/test hashes**, verifies no source drift during the run, and binds its four infrastructure manifests and transcript by SHA-256. No application, test or validation source changed after that gate. Earlier v1/v2 definition objects and hash expressions were separately compared unchanged against the baseline.

| Evidence | What it establishes |
| --- | --- |
| [Summary](evidence/daw-4/summary.json), [raw transcript](evidence/daw-4/validation.log) | Exact commands, runtime, counts, source hashes, all positive tests and mutation verdicts |
| [Agent journal and process evidence](evidence/daw-4/agent.json) | Fifteen real-PostgreSQL cases; decisions, observations, cost reservations, events and owned-worker exits |
| [Admission](evidence/daw-4/integration.json), [execution](evidence/daw-4/execution.json), [external effects](evidence/daw-4/effects.json) | Preserved DAW-1/2/3 races, failure windows and independent simulator behavior |
| [Admission controls](evidence/daw-4/negative-controls.json), [execution controls](evidence/daw-4/execution-negative-controls.json), [effect controls](evidence/daw-4/effect-negative-controls.json) | All twelve earlier regression witnesses retained; sibling directories hold their raw logs |
| [Agent controls](evidence/daw-4/agent-negative-controls.json) | Four new named witnesses and expected failing exits |
| [Output validation](evidence/daw-4/agent-output/tests.log), [allowlisting](evidence/daw-4/agent-allowlist/tests.log) | Removing schema validation or registered-tool lookup is detected |
| [Checkpoint reuse](evidence/daw-4/agent-checkpoint/tests.log), [turn budget](evidence/daw-4/agent-budget/tests.log) | Ignoring accepted history after restart or bypassing the persisted turn limit is detected |

The positive SIGKILL witness blocks the observation transaction **after** a decision has committed, kills an actual worker, then starts a replacement. Its final journal has two accepted decisions, only **one** call for turn 1, and the original first decision unchanged. An interrupted read can reserve again; this does not regenerate the accepted model decision. Another test loses the second model response after saving the first observation: recovery finishes with three model-call reservations but only one tool execution. Saved finish reuse performs zero further model calls. Stale-owner, acceptance-event rollback, invalid registered-tool input and malformed-provider-envelope cases run against real PostgreSQL.

The earlier pre-review gate at `.local/results/2026-09-05T21-02-15-114Z-d2d0ece3-ee26-4fd0-9bef-1141005ffa0b` passed its then-current 69 tests and 16 mutations but correctly failed its source-drift check because review fixes were made during that run. It is retained locally, **not** used for sign-off. The complete fixed-source run above supersedes it. A separate optional attempt to exercise the live-adapter-selection rejection was denied by the execution safety gate before running; that extra check is not claimed as executed. The early rejection was inspected in source. No live provider call was made or needed.

### Standards review

The independent Standards review found two issues: malformed/null provider envelopes could be classified as retryable transport failures, and a failed advisory-lock operation could bypass test-client release. Invalid envelopes now become permanent policy rejections with a REJECTED call journal; nested cleanup always releases the barrier client. Targeted unit and real-worker regression cases pass. Follow-up review: **zero unresolved findings**. Review inspected source; the full gate above provides execution evidence.

### Spec review

The independent Spec review found two issues: malformed provider output must not become a transport retry, and invalid arguments for a registered tool needed a direct worker/PostgreSQL witness. Both are addressed: the added cases terminate without accepted decisions or tool execution and retain REJECTED call records. Follow-up review: **zero unresolved findings**. No approvals, write-capable agent tools or later-milestone features were added.

### Commit boundary and limits

This checkpoint includes only the scoped agent schema/domain/adapter/execution changes, tests, CI wiring, documentation and curated final evidence. All **40** curated evidence files were byte-for-byte compared with the final run; the post-curation offline guard passed again with **180 files and zero findings**. The lockfile adds the already-resolved Ajv version as a direct dependency, without a dependency-resolution upgrade. Raw assertion whitespace is retained with sixteen exact `.gitattributes` evidence-log exceptions; source diagnostics are unchanged. Historical evidence remains untouched; routine results, compiled output, dependencies, private configuration and retained clusters remain untracked/ignored.

This is one **local** DAW-4 commit, not a publication checkpoint. Remote CI for this candidate and paid OpenAI execution have not been run. The estimate ledger is not provider billing enforcement; deterministic fixtures are not an AI-quality benchmark. Database loss, hostile workers/providers, arbitrary-executor preemption and arbitrary crash safety are not proven. DAW-5 through DAW-7 remain unstarted; the other portfolio repositories and Career Ops are untouched.
