CREATE TABLE agent_sessions (
  run_id uuid NOT NULL,
  step_key text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('deterministic','openai')),
  model text NOT NULL,
  max_turns integer NOT NULL CHECK (max_turns BETWEEN 1 AND 4),
  max_calls integer NOT NULL CHECK (max_calls BETWEEN 1 AND 5),
  max_tool_calls integer NOT NULL CHECK (max_tool_calls BETWEEN 1 AND 3),
  max_cost_micros integer NOT NULL CHECK (max_cost_micros BETWEEN 1 AND 40000),
  call_cost_micros integer NOT NULL CHECK (call_cost_micros BETWEEN 1 AND 10000),
  call_timeout_ms integer NOT NULL CHECK (call_timeout_ms BETWEEN 1 AND 5000),
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0 AND calls <= max_calls),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0 AND tool_calls <= max_tool_calls),
  reserved_cost_micros integer NOT NULL DEFAULT 0 CHECK (reserved_cost_micros >= 0 AND reserved_cost_micros <= max_cost_micros),
  PRIMARY KEY (run_id, step_key),
  FOREIGN KEY (run_id, step_key) REFERENCES step_runs(run_id, step_key)
);
CREATE TABLE agent_calls (
  run_id uuid NOT NULL,
  step_key text NOT NULL,
  call_no integer NOT NULL CHECK (call_no > 0),
  turn integer NOT NULL CHECK (turn BETWEEN 1 AND 4),
  fence integer NOT NULL,
  reserved_cost_micros integer NOT NULL CHECK (reserved_cost_micros > 0),
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','ACCEPTED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, step_key, call_no),
  FOREIGN KEY (run_id, step_key) REFERENCES agent_sessions(run_id, step_key)
);
CREATE TABLE agent_decisions (
  run_id uuid NOT NULL,
  step_key text NOT NULL,
  turn integer NOT NULL CHECK (turn BETWEEN 1 AND 4),
  call_no integer NOT NULL,
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision) = 'object'),
  observation jsonb CHECK (jsonb_typeof(observation) = 'object'),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, step_key, turn),
  UNIQUE (run_id, step_key, call_no),
  FOREIGN KEY (run_id, step_key, call_no) REFERENCES agent_calls(run_id, step_key, call_no)
);
ALTER TABLE run_events DROP CONSTRAINT run_events_type_check;
ALTER TABLE run_events ADD CHECK (type IN ('RUN_CREATED','STEP_CLAIMED','STEP_SUCCEEDED','RETRY_SCHEDULED','RETRY_READY','RUN_SUCCEEDED','RUN_FAILED','EFFECT_UNKNOWN','EFFECT_VERIFIED','RECONCILIATION_REQUIRED','AGENT_CALL_RESERVED','AGENT_DECISION_ACCEPTED','AGENT_OUTPUT_REJECTED','AGENT_OBSERVATION_SAVED'));
