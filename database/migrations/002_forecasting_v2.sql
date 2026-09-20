CREATE TABLE IF NOT EXISTS mart.forecast_run_meta (
  forecast_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engine_version text NOT NULL,
  target_name text NOT NULL,
  horizon_months integer NOT NULL CHECK (horizon_months BETWEEN 1 AND 36),
  latest_closed_month date NOT NULL,
  training_started_at timestamptz NOT NULL DEFAULT now(),
  training_completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'validated', 'rejected', 'failed')),
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  code_version text,
  initiated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_trunc('month', latest_closed_month)::date = latest_closed_month)
);

CREATE TABLE IF NOT EXISTS mart.forecast_output (
  forecast_run_id uuid NOT NULL REFERENCES mart.forecast_run_meta(forecast_run_id),
  job_key bigint NOT NULL REFERENCES core.dim_job(job_key),
  forecast_month date NOT NULL,
  point_forecast numeric(18, 2) NOT NULL,
  lower_bound numeric(18, 2),
  upper_bound numeric(18, 2),
  selected_model text NOT NULL,
  model_scores jsonb NOT NULL,
  input_periods jsonb NOT NULL,
  excluded_periods jsonb NOT NULL DEFAULT '[]'::jsonb,
  interval_source text,
  feature_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (forecast_run_id, job_key, forecast_month),
  CHECK (date_trunc('month', forecast_month)::date = forecast_month),
  CHECK (lower_bound IS NULL OR upper_bound IS NULL OR lower_bound <= point_forecast AND point_forecast <= upper_bound)
);

CREATE TABLE IF NOT EXISTS mart.forecast_track_record (
  forecast_run_id uuid NOT NULL REFERENCES mart.forecast_run_meta(forecast_run_id),
  job_key bigint NOT NULL REFERENCES core.dim_job(job_key),
  forecast_month date NOT NULL,
  horizon integer NOT NULL CHECK (horizon >= 1),
  point_forecast numeric(18, 2) NOT NULL,
  lower_bound numeric(18, 2),
  upper_bound numeric(18, 2),
  actual_value numeric(18, 2),
  absolute_error numeric(18, 2),
  interval_hit boolean,
  actual_closed_at timestamptz,
  PRIMARY KEY (forecast_run_id, job_key, forecast_month, horizon)
);

CREATE INDEX IF NOT EXISTS forecast_output_job_month_idx
  ON mart.forecast_output (job_key, forecast_month, created_at DESC);
CREATE INDEX IF NOT EXISTS forecast_track_record_job_month_idx
  ON mart.forecast_track_record (job_key, forecast_month DESC);

