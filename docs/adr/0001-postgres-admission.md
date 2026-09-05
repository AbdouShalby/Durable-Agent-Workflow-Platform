# PostgreSQL owns admission and initial scheduling

Status: accepted for DAW-1, following the approved DAW-0 design.

Store workflow runs, initial step states and creation events in one PostgreSQL transaction. Use a unique caller/key constraint with `ON CONFLICT DO NOTHING` and a separate READ COMMITTED lookup for replay/conflict resolution. This makes database state authoritative and avoids a run-state/queue-message dual write.

A separate Redis/RabbitMQ queue would introduce a publication boundary without adding required DAW-1 evidence. Temporal/LangGraph remain credible alternatives for a broader workflow platform; this repository intentionally implements a small, explicit admission foundation rather than a general orchestration framework. The READY index is not an implemented scheduler or a claim of production queue capacity.

Definition version is explicit and its metadata/hash is persisted; new semantics require a new version. Step results, attempts, leases, external invocation journals and human decisions are later milestones, not empty tables created to imply those features already exist.
