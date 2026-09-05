# Durable Workflow Context

**Workflow definition**: A versioned, trusted description of permitted steps and their order.

**Workflow run**: One admitted request bound to a workflow definition version and fixed input.

**Step**: A logical unit of work in a workflow run. Being scheduled does not mean it has executed.

**Idempotency key**: The caller-scoped identity of a creation request, reusable only for the same intended parameters.

**Request fingerprint**: A digest of the canonical intended request, used to reject incompatible key reuse.

**Initial schedule**: The durable record of which initial step is ready and which later steps are blocked.
