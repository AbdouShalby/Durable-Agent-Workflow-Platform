ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_state_check;
ALTER TABLE workflow_runs ADD CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','RECONCILIATION_REQUIRED'));
ALTER TABLE step_runs DROP CONSTRAINT step_runs_state_check;
ALTER TABLE step_runs ADD CHECK (state IN ('BLOCKED','READY','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED','UNKNOWN'));
CREATE TABLE tool_invocations (
  run_id uuid NOT NULL,
  step_key text NOT NULL,
  effect_key text NOT NULL UNIQUE CHECK (effect_key ~ '^[a-f0-9]{64}$'),
  contract text NOT NULL CHECK (contract IN ('keyed','unkeyed')),
  service_id uuid NOT NULL,
  service_url text NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED','UNKNOWN','VERIFIED')),
  sends integer NOT NULL DEFAULT 0 CHECK (sends>=0),
  verifications integer NOT NULL DEFAULT 0 CHECK (verifications>=0),
  receipt jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,step_key),
  FOREIGN KEY (run_id,step_key) REFERENCES step_runs(run_id,step_key),
  CHECK ((state='VERIFIED')=(receipt IS NOT NULL))
);
ALTER TABLE run_events DROP CONSTRAINT run_events_type_check;
ALTER TABLE run_events ADD CHECK (type IN ('RUN_CREATED','STEP_CLAIMED','STEP_SUCCEEDED','RETRY_SCHEDULED','RETRY_READY','RUN_SUCCEEDED','RUN_FAILED','EFFECT_UNKNOWN','EFFECT_VERIFIED','RECONCILIATION_REQUIRED'));
