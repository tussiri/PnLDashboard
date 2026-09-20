CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS ops.integration_sync_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_name text NOT NULL,
  resource_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  records_fetched integer NOT NULL DEFAULT 0 CHECK (records_fetched >= 0),
  records_inserted integer NOT NULL DEFAULT 0 CHECK (records_inserted >= 0),
  error_message text,
  CHECK ((status = 'running' AND completed_at IS NULL) OR status <> 'running')
);

CREATE INDEX IF NOT EXISTS integration_sync_run_lookup_idx
  ON ops.integration_sync_run (integration_name, resource_name, started_at DESC);

CREATE TABLE IF NOT EXISTS ops.source_watermark (
  integration_name text NOT NULL,
  resource_name text NOT NULL,
  watermark_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_name, resource_name)
);

CREATE TABLE IF NOT EXISTS raw.winteam_record (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_run_id uuid NOT NULL REFERENCES ops.integration_sync_run(id),
  resource_name text NOT NULL,
  source_record_id text NOT NULL,
  source_updated_at text,
  payload_hash char(64) NOT NULL,
  payload jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_name, source_record_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS winteam_record_current_idx
  ON raw.winteam_record (resource_name, source_record_id, ingested_at DESC);
CREATE INDEX IF NOT EXISTS winteam_record_payload_gin_idx
  ON raw.winteam_record USING gin (payload);

CREATE OR REPLACE VIEW raw.v_winteam_current AS
SELECT DISTINCT ON (resource_name, source_record_id)
  id, sync_run_id, resource_name, source_record_id, source_updated_at,
  payload_hash, payload, ingested_at
FROM raw.winteam_record
ORDER BY resource_name, source_record_id, ingested_at DESC, id DESC;

CREATE TABLE IF NOT EXISTS core.dim_parent_account (
  parent_account_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text UNIQUE,
  account_name text NOT NULL,
  vertical text,
  active boolean NOT NULL DEFAULT true,
  source_updated_at timestamptz,
  warehouse_updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.dim_job (
  job_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL,
  identity_version integer NOT NULL DEFAULT 1,
  parent_account_key bigint REFERENCES core.dim_parent_account(parent_account_key),
  job_number text,
  job_name text,
  status text,
  service_type text,
  branch_name text,
  region_name text,
  address_line_1 text,
  city text,
  state_province text,
  postal_code text,
  country_code char(2),
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  source_updated_at timestamptz,
  warehouse_updated_at timestamptz NOT NULL DEFAULT now(),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  UNIQUE (winteam_id, identity_version),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS core.dim_vendor (
  vendor_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text UNIQUE,
  vendor_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source_updated_at timestamptz,
  warehouse_updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.fact_invoice (
  invoice_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL UNIQUE,
  job_key bigint REFERENCES core.dim_job(job_key),
  vendor_key bigint REFERENCES core.dim_vendor(vendor_key),
  invoice_number text,
  service_period_start date,
  service_period_end date,
  invoice_date date,
  approval_date date,
  amount numeric(18, 2),
  currency_code char(3),
  status text,
  is_credit boolean,
  is_duplicate boolean NOT NULL DEFAULT false,
  source_updated_at timestamptz,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (service_period_end IS NULL OR service_period_start IS NULL OR service_period_end >= service_period_start)
);

CREATE INDEX IF NOT EXISTS fact_invoice_job_period_idx
  ON core.fact_invoice (job_key, service_period_end DESC);

CREATE TABLE IF NOT EXISTS core.fact_timekeeping (
  timekeeping_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL UNIQUE,
  job_key bigint REFERENCES core.dim_job(job_key),
  employee_source_id text,
  work_date date NOT NULL,
  regular_hours numeric(10, 2),
  overtime_hours numeric(10, 2),
  labor_cost numeric(18, 2),
  approval_status text,
  source_updated_at timestamptz,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (regular_hours IS NULL OR regular_hours >= 0),
  CHECK (overtime_hours IS NULL OR overtime_hours >= 0)
);

CREATE INDEX IF NOT EXISTS fact_timekeeping_job_date_idx
  ON core.fact_timekeeping (job_key, work_date DESC);

CREATE OR REPLACE VIEW mart.v_winteam_ingestion_freshness AS
SELECT
  configured.resource_name,
  latest.status AS last_status,
  latest.started_at AS last_started_at,
  latest.completed_at AS last_completed_at,
  latest.records_fetched,
  latest.records_inserted,
  watermark.watermark_value,
  watermark.updated_at AS watermark_updated_at,
  extract(epoch FROM (now() - latest.completed_at))::bigint AS seconds_since_last_completion
FROM (SELECT DISTINCT resource_name FROM ops.integration_sync_run) configured
LEFT JOIN LATERAL (
  SELECT status, started_at, completed_at, records_fetched, records_inserted
  FROM ops.integration_sync_run r
  WHERE r.integration_name = 'winteam' AND r.resource_name = configured.resource_name
  ORDER BY started_at DESC
  LIMIT 1
) latest ON true
LEFT JOIN ops.source_watermark watermark
  ON watermark.integration_name = 'winteam' AND watermark.resource_name = configured.resource_name;

