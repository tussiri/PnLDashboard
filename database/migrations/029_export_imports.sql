-- 029: WinTeam report exports imported as files (docs/export-feeds.md, app/imports.py).
--
-- The API has no pay amounts and no job-cost P&L, so the scheduled Pay Report Timekeeping and Job
-- Cost Analysis exports are loaded from CSV/XLSX files (upload or the import inbox). Every file is
-- logged in ops.import_file by content hash. A pay report replaces the rows of its company over the
-- work dates it covers (restated and deleted punches included) and records that window in
-- core.pay_report_coverage, which is how the weekly leadership mart knows a job-week's labor dollars
-- are payroll figures rather than an estimate.

CREATE TABLE IF NOT EXISTS ops.import_file (
  import_file_id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('pay_report', 'job_cost')),
  file_name text NOT NULL,
  sha256 text NOT NULL,
  origin text NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'inbox')),
  status text NOT NULL CHECK (status IN ('loaded', 'failed', 'duplicate')),
  rows_read integer NOT NULL DEFAULT 0,
  rows_loaded integer NOT NULL DEFAULT 0,
  companies text[] NOT NULL DEFAULT '{}',
  period_from date,
  period_to date,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  uploaded_by text,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS import_file_loaded_hash_idx ON ops.import_file (kind, sha256) WHERE status = 'loaded';

CREATE TABLE IF NOT EXISTS core.fact_pay_report (
  import_file_id bigint NOT NULL REFERENCES ops.import_file (import_file_id),
  company text NOT NULL,
  employee_number text NOT NULL,
  job_number text NOT NULL,
  work_date date NOT NULL,
  tk_hours_id text,
  hours_type_id text,
  hours_type_description text,
  regular_hours numeric(12, 2) NOT NULL DEFAULT 0,
  overtime_hours numeric(12, 2) NOT NULL DEFAULT 0,
  doubletime_hours numeric(12, 2) NOT NULL DEFAULT 0,
  total_hours numeric(12, 2) NOT NULL DEFAULT 0,
  pay_rate numeric(12, 4),
  ot_rate numeric(12, 4),
  dt_rate numeric(12, 4),
  regular_dollars numeric(14, 2) NOT NULL DEFAULT 0,
  overtime_dollars numeric(14, 2) NOT NULL DEFAULT 0,
  doubletime_dollars numeric(14, 2) NOT NULL DEFAULT 0,
  total_dollars numeric(14, 2) NOT NULL DEFAULT 0,
  paid_by_check_id text,
  supervisor text,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_pay_report_company_date_idx ON core.fact_pay_report (company, work_date);
CREATE INDEX IF NOT EXISTS fact_pay_report_job_date_idx ON core.fact_pay_report (job_number, work_date);

COMMENT ON TABLE core.fact_pay_report IS
  'WinTeam Pay Report Timekeeping rows (one per employee, job, work date, hours type). Dollars are full pay: overtime_dollars is 1.5x pay, not the premium.';

CREATE TABLE IF NOT EXISTS core.pay_report_coverage (
  company text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL CHECK (date_to >= date_from),
  import_file_id bigint NOT NULL REFERENCES ops.import_file (import_file_id),
  PRIMARY KEY (company, date_from, date_to, import_file_id)
);

COMMENT ON TABLE core.pay_report_coverage IS
  'Work-date windows a loaded pay report covers per company. A job-week inside a window takes its labor dollars from core.fact_pay_report.';

-- One job-cost row per job and month. An imported Job Cost Analysis file supersedes the restored
-- finance_reference export for the same job and month; otherwise the latest load wins.
CREATE OR REPLACE VIEW mart.v_job_cost_month_effective AS
SELECT DISTINCT ON (job_number, month) *
FROM core.fact_job_cost_month
ORDER BY job_number, month, (source = 'export_import') DESC, warehouse_loaded_at DESC;
