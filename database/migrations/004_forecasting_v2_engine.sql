-- 004: Align the forecast contract with the v2 site-level engine (ported from Finance_Reporting).
--
-- 002 created the tables keyed by job_key only. The engine is keyed by job_number + metric and also
-- publishes a portfolio row (job_number = '__ALL__') that has no dim_job entry, so the primary keys
-- are recreated here. The tables were empty at the time of this migration; 002 is left untouched.

-- Run metadata: keep 002 columns, add the engine's structured sections.
ALTER TABLE mart.forecast_run_meta
  ALTER COLUMN initiated_by SET DEFAULT 'scheduled-rebuild',
  ADD COLUMN IF NOT EXISTS dataset jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS gates jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS disruption jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS portfolio jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metrics text[] NOT NULL DEFAULT '{revenue,gross_profit}';

-- Forecast output: one row per (run, job_number, metric, forecast_month).
ALTER TABLE mart.forecast_output DROP CONSTRAINT IF EXISTS forecast_output_pkey;
ALTER TABLE mart.forecast_output
  ALTER COLUMN job_key DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS job_name text,
  ADD COLUMN IF NOT EXISTS metric text,
  ADD COLUMN IF NOT EXISTS basis_month date,
  ADD COLUMN IF NOT EXISTS horizon_step integer,
  ADD COLUMN IF NOT EXISTS explanation text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS volatility_class text,
  ADD COLUMN IF NOT EXISTS n_history integer,
  ADD COLUMN IF NOT EXISTS disruption jsonb,
  ADD COLUMN IF NOT EXISTS identity_meta jsonb,
  ADD COLUMN IF NOT EXISTS quality_meta jsonb,
  ADD COLUMN IF NOT EXISTS engine_version text;
UPDATE mart.forecast_output SET job_number = job_key::text WHERE job_number IS NULL;
UPDATE mart.forecast_output SET metric = 'revenue' WHERE metric IS NULL;
UPDATE mart.forecast_output SET horizon_step = 1 WHERE horizon_step IS NULL;
ALTER TABLE mart.forecast_output
  ALTER COLUMN job_number SET NOT NULL,
  ALTER COLUMN metric SET NOT NULL,
  ALTER COLUMN horizon_step SET NOT NULL,
  ADD PRIMARY KEY (forecast_run_id, job_number, metric, forecast_month);
ALTER TABLE mart.forecast_output DROP CONSTRAINT IF EXISTS forecast_output_metric_check;
ALTER TABLE mart.forecast_output
  ADD CONSTRAINT forecast_output_metric_check CHECK (metric IN ('revenue', 'gross_profit', 'labor_cost', 'hours'));
CREATE INDEX IF NOT EXISTS forecast_output_number_metric_idx
  ON mart.forecast_output (job_number, metric, forecast_month);

-- Track record: every historical walk-forward call with its band and the eventual actual.
ALTER TABLE mart.forecast_track_record DROP CONSTRAINT IF EXISTS forecast_track_record_pkey;
ALTER TABLE mart.forecast_track_record
  ALTER COLUMN job_key DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS metric text,
  ADD COLUMN IF NOT EXISTS origin_month date,
  ADD COLUMN IF NOT EXISTS method text,
  ADD COLUMN IF NOT EXISTS scaled_error numeric(12, 6),
  ADD COLUMN IF NOT EXISTS volatility_class text;
UPDATE mart.forecast_track_record SET job_number = job_key::text WHERE job_number IS NULL;
UPDATE mart.forecast_track_record SET metric = 'revenue' WHERE metric IS NULL;
ALTER TABLE mart.forecast_track_record
  ALTER COLUMN job_number SET NOT NULL,
  ALTER COLUMN metric SET NOT NULL,
  ADD PRIMARY KEY (forecast_run_id, job_number, metric, forecast_month, horizon);
CREATE INDEX IF NOT EXISTS forecast_track_record_number_idx
  ON mart.forecast_track_record (job_number, metric, forecast_month DESC);

-- Per-series accuracy (only published with >= 3 backtests).
CREATE TABLE IF NOT EXISTS mart.forecast_accuracy (
  forecast_run_id uuid NOT NULL REFERENCES mart.forecast_run_meta(forecast_run_id) ON DELETE CASCADE,
  job_number text NOT NULL,
  metric text NOT NULL,
  horizon_step integer NOT NULL CHECK (horizon_step >= 1),
  method text,
  n_backtests integer NOT NULL DEFAULT 0,
  median_ape numeric(12, 6),
  mape numeric(12, 6),
  mase numeric(12, 6),
  coverage numeric(9, 6),
  volatility_class text,
  engine_version text,
  PRIMARY KEY (forecast_run_id, job_number, metric, horizon_step)
);

-- Series that were gated out instead of forecast.
CREATE TABLE IF NOT EXISTS mart.forecast_series_status (
  forecast_run_id uuid NOT NULL REFERENCES mart.forecast_run_meta(forecast_run_id) ON DELETE CASCADE,
  job_number text NOT NULL,
  job_name text,
  metric text NOT NULL,
  status text NOT NULL CHECK (status IN ('insufficient_history', 'stale_data', 'inactive')),
  reason text,
  last_valid_month date,
  n_valid integer NOT NULL DEFAULT 0,
  PRIMARY KEY (forecast_run_id, job_number, metric)
);

-- Latest validated run, for the API and Metabase.
CREATE OR REPLACE VIEW mart.v_forecast_latest_run AS
SELECT *
FROM mart.forecast_run_meta
WHERE status = 'validated'
ORDER BY training_completed_at DESC NULLS LAST, created_at DESC
LIMIT 1;
