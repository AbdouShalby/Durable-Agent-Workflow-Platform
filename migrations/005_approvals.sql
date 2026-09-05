ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_state_check;
ALTER TABLE workflow_runs ADD CHECK (state IN ('QUEUED','RUNNING','WAITING_APPROVAL','SUCCEEDED','FAILED','CANCELLED','RECONCILIATION_REQUIRED'));
ALTER TABLE workflow_runs ADD COLUMN cancel_requested_at timestamptz;
ALTER TABLE step_runs DROP CONSTRAINT step_runs_state_check;
ALTER TABLE step_runs ADD CHECK (state IN ('BLOCKED','READY','RUNNING','RETRY_WAIT','WAITING_APPROVAL','SUCCEEDED','FAILED','CANCELLED','UNKNOWN'));
ALTER TABLE step_attempts DROP CONSTRAINT step_attempts_outcome_check;
ALTER TABLE step_attempts ADD CHECK (outcome IN ('RUNNING','SUCCEEDED','RETRYABLE','PERMANENT','EXPIRED','CANCELLED'));
CREATE TABLE governed_actions (
  run_id uuid PRIMARY KEY REFERENCES workflow_runs(id),
  step_key text NOT NULL CHECK (step_key='write-summary'),
  policy_version text NOT NULL,
  policy_fingerprint text NOT NULL CHECK (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  requires_approval boolean NOT NULL,
  service_id uuid NOT NULL,
  service_url text NOT NULL,
  FOREIGN KEY (run_id,step_key) REFERENCES step_runs(run_id,step_key)
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES governed_actions(run_id),
  step_key text NOT NULL,
  tool text NOT NULL CHECK (tool='write-summary'),
  action_fingerprint text NOT NULL CHECK (action_fingerprint ~ '^[a-f0-9]{64}$'),
  policy_version text NOT NULL,
  policy_fingerprint text NOT NULL CHECK (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('PENDING','APPROVED','REJECTED','EXPIRED','INVALIDATED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  decision text CHECK (decision IN ('approve','reject')),
  decided_by text,
  decided_at timestamptz,
  authorized_at timestamptz,
  FOREIGN KEY (run_id,step_key) REFERENCES tool_invocations(run_id,step_key),
  CHECK ((decision IS NULL AND decided_by IS NULL AND decided_at IS NULL) OR
         (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_by='local-approver' AND decided_at IS NOT NULL)),
  CHECK (state NOT IN ('APPROVED','REJECTED') OR decision IS NOT NULL),
  CHECK (state<>'APPROVED' OR decision='approve'),
  CHECK (state<>'REJECTED' OR decision='reject'),
  CHECK (authorized_at IS NULL OR decision='approve')
);
CREATE INDEX approvals_expiry ON approvals(expires_at) WHERE state IN ('PENDING','APPROVED');
ALTER TABLE run_events DROP CONSTRAINT run_events_type_check;
ALTER TABLE run_events ADD CHECK (type IN ('RUN_CREATED','STEP_CLAIMED','STEP_SUCCEEDED','RETRY_SCHEDULED','RETRY_READY','RUN_SUCCEEDED','RUN_FAILED','EFFECT_UNKNOWN','EFFECT_VERIFIED','RECONCILIATION_REQUIRED','AGENT_CALL_RESERVED','AGENT_DECISION_ACCEPTED','AGENT_OUTPUT_REJECTED','AGENT_OBSERVATION_SAVED','APPROVAL_REQUESTED','APPROVAL_DECIDED','APPROVAL_EXPIRED','APPROVAL_INVALIDATED','APPROVAL_AUTHORIZED','RUN_CANCELLED','CANCEL_REQUESTED'));
