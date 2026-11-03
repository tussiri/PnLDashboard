-- 060: the Claude explanation of an account's week-over-week labor change (app/week_changes.py). One row per
-- account and week; input_hash is a digest of the facts it read, so it is rebuilt only when they change. The
-- numbers on the card are computed in code; this holds the labeled AI summary of them.

CREATE TABLE IF NOT EXISTS ops.week_change_summary (
  account text NOT NULL,
  week_start date NOT NULL,
  input_hash text NOT NULL,
  summary jsonb,
  model text,
  error text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, week_start)
);
