ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_state_check;
ALTER TABLE workflow_runs ADD CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED'));
ALTER TABLE step_runs DROP CONSTRAINT step_runs_state_check;
ALTER TABLE step_runs DROP CONSTRAINT step_runs_check;
ALTER TABLE step_runs
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN fence integer NOT NULL DEFAULT 0 CHECK (fence >= 0),
  ADD COLUMN owner uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN result jsonb,
  ADD COLUMN last_error text,
  ADD COLUMN lease_ms integer NOT NULL DEFAULT 3000 CHECK (lease_ms BETWEEN 500 AND 60000),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN retry_base_ms integer NOT NULL DEFAULT 200 CHECK (retry_base_ms BETWEEN 1 AND 60000),
  ADD COLUMN retry_cap_ms integer NOT NULL DEFAULT 2000 CHECK (retry_cap_ms BETWEEN retry_base_ms AND 60000),
  ADD COLUMN max_elapsed_ms integer NOT NULL DEFAULT 30000 CHECK (max_elapsed_ms BETWEEN lease_ms AND 600000),
  ADD CHECK (state IN ('BLOCKED','READY','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED')),
  ADD CHECK ((state IN ('READY','RETRY_WAIT') AND available_at IS NOT NULL) OR
             (state NOT IN ('READY','RETRY_WAIT') AND available_at IS NULL)),
  ADD CHECK ((state='RUNNING' AND owner IS NOT NULL AND lease_expires_at IS NOT NULL AND deadline_at IS NOT NULL) OR
             (state<>'RUNNING' AND owner IS NULL AND lease_expires_at IS NULL)),
  ADD CHECK ((state='SUCCEEDED') = (result IS NOT NULL)),
  ADD CHECK (attempt_count <= max_attempts AND fence = attempt_count);
CREATE UNIQUE INDEX step_runs_one_running ON step_runs(run_id) WHERE state='RUNNING';
CREATE INDEX step_runs_recovery ON step_runs(lease_expires_at, available_at) WHERE state IN ('RUNNING','RETRY_WAIT');

CREATE TABLE step_attempts (
  run_id uuid NOT NULL,
  step_key text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  fence integer NOT NULL CHECK (fence = attempt),
  owner uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('RUNNING','SUCCEEDED','RETRYABLE','PERMANENT','EXPIRED')),
  error_code text,
  retry_delay_ms integer CHECK (retry_delay_ms BETWEEN 0 AND 60000),
  PRIMARY KEY (run_id,step_key,attempt),
  FOREIGN KEY (run_id,step_key) REFERENCES step_runs(run_id,step_key),
  CHECK ((outcome='RUNNING' AND ended_at IS NULL) OR (outcome<>'RUNNING' AND ended_at IS NOT NULL))
);
ALTER TABLE run_events DROP CONSTRAINT run_events_type_check;
ALTER TABLE run_events ADD CHECK (type IN ('RUN_CREATED','STEP_CLAIMED','STEP_SUCCEEDED','RETRY_SCHEDULED','RETRY_READY','RUN_SUCCEEDED','RUN_FAILED'));
ALTER TABLE run_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
