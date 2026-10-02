-- 045: the Claude comment summary behind the Home feedback tile (app/feedback_ai.py). One row per
-- account and scope; input_hash is a digest of the comments summarized, so the summary is rebuilt only
-- when they change. An AI summary of customer comments, labeled as such; scores are computed in SQL.

CREATE TABLE IF NOT EXISTS ops.feedback_summary (
  account text NOT NULL,
  scope text NOT NULL,
  input_hash text NOT NULL,
  summary jsonb,
  model text,
  comments integer NOT NULL DEFAULT 0,
  error text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, scope)
);
