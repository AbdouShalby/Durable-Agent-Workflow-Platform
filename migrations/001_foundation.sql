CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY,
  caller_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  workflow_name text NOT NULL,
  workflow_version integer NOT NULL CHECK (workflow_version > 0),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  state text NOT NULL CHECK (state = 'QUEUED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (caller_id, idempotency_key)
);

CREATE TABLE step_runs (
  run_id uuid NOT NULL REFERENCES workflow_runs(id),
  step_key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  state text NOT NULL CHECK (state IN ('READY', 'BLOCKED')),
  available_at timestamptz,
  PRIMARY KEY (run_id, step_key),
  UNIQUE (run_id, ordinal),
  CHECK ((state = 'READY' AND available_at IS NOT NULL) OR
         (state = 'BLOCKED' AND available_at IS NULL))
);
CREATE INDEX step_runs_ready ON step_runs (available_at, run_id) WHERE state = 'READY';

CREATE TABLE run_events (
  run_id uuid NOT NULL REFERENCES workflow_runs(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  type text NOT NULL CHECK (type = 'RUN_CREATED'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, sequence)
);
