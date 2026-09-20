-- 005: A second data source: the real WinTeam report exports restored from the Finance_Dashboard
-- database (finance_reference). Adds source-agnostic job-cost and aging facts, company/delivery
-- dimensions, and the cost breakdown the job-cost P&L carries that the WinTeam API does not.

-- Source provenance on every fact/dim row that can come from more than one source.
ALTER TABLE core.dim_job
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api',
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS company_name_raw text,
  ADD COLUMN IF NOT EXISTS delivery_model text CHECK (delivery_model IS NULL OR delivery_model IN ('self_perform', 'subcontracted')),
  ADD COLUMN IF NOT EXISTS account_group text,
  ADD COLUMN IF NOT EXISTS customer_number text,
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS geo_precision text CHECK (geo_precision IS NULL OR geo_precision IN ('exact', 'city_center')),
  ADD COLUMN IF NOT EXISTS date_discontinued date;

ALTER TABLE core.fact_timekeeping
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api',
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS double_time_hours numeric(10, 2),
  ADD COLUMN IF NOT EXISTS hours_type text,
  ADD COLUMN IF NOT EXISTS employee_name text,
  ADD COLUMN IF NOT EXISTS labor_cost_basis text
    CHECK (labor_cost_basis IS NULL OR labor_cost_basis IN ('hours_x_rate', 'export_dollars', 'trailing_job_rate', 'none'));

ALTER TABLE core.fact_ar_invoice
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api',
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS parent_customer_number text,
  ADD COLUMN IF NOT EXISTS parent_customer_name text,
  ADD COLUMN IF NOT EXISTS is_collectible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS days_outstanding_snapshot integer,
  ADD COLUMN IF NOT EXISTS aging_bucket_snapshot text,
  ADD COLUMN IF NOT EXISTS open_balance_basis text
    CHECK (open_balance_basis IS NULL OR open_balance_basis IN ('api_amount_paid', 'aging_snapshot', 'assumed_paid'));

ALTER TABLE core.fact_ap_invoice
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api',
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS vendor_name text,
  ADD COLUMN IF NOT EXISTS vendor_type text,
  ADD COLUMN IF NOT EXISTS amount_paid numeric(18, 2),
  ADD COLUMN IF NOT EXISTS open_balance numeric(18, 2),
  ADD COLUMN IF NOT EXISTS days_past_due integer,
  ADD COLUMN IF NOT EXISTS snapshot_date date;

ALTER TABLE core.fact_ap_payment ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api';
ALTER TABLE core.fact_schedule ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api';
ALTER TABLE core.fact_gl_budget ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api';
ALTER TABLE core.dim_vendor ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api';
ALTER TABLE core.dim_customer ADD COLUMN IF NOT EXISTS company text;

-- Job-cost P&L by job and month (WinTeam Job Cost Analysis via the reference marts). Source
-- agnostic so a future API or export can fill it too. Preferred over AR/timekeeping derivation
-- when present for a (job, month).
CREATE TABLE IF NOT EXISTS core.fact_job_cost_month (
  source text NOT NULL,
  job_number text NOT NULL,
  month date NOT NULL,
  job_name text,
  company text,
  revenue numeric(18, 2) NOT NULL DEFAULT 0,
  direct_labor numeric(18, 2) NOT NULL DEFAULT 0,
  payroll_taxes_insurance numeric(18, 2) NOT NULL DEFAULT 0,
  materials numeric(18, 2) NOT NULL DEFAULT 0,
  subcontractors numeric(18, 2) NOT NULL DEFAULT 0,
  equipment_supplies numeric(18, 2) NOT NULL DEFAULT 0,
  other_direct_costs numeric(18, 2) NOT NULL DEFAULT 0,
  total_direct_costs numeric(18, 2) NOT NULL DEFAULT 0,
  gross_profit numeric(18, 2) NOT NULL DEFAULT 0,
  budget_revenue numeric(18, 2),
  budget_direct_costs numeric(18, 2),
  budget_labor numeric(18, 2),
  budget_hours numeric(12, 2),
  actual_hours numeric(12, 2),
  overtime_hours numeric(12, 2),
  data_quality_status text NOT NULL DEFAULT 'passed' CHECK (data_quality_status IN ('passed', 'warning')),
  confidence_score integer,
  exception_count integer,
  lineage jsonb NOT NULL DEFAULT '{}'::jsonb,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, job_number, month),
  CHECK (date_trunc('month', month)::date = month)
);
CREATE INDEX IF NOT EXISTS fact_job_cost_month_month_idx ON core.fact_job_cost_month (month);

-- Monthly labor budget by job from the daily budget / hours budget comparison exports.
CREATE TABLE IF NOT EXISTS core.fact_labor_budget_month (
  source text NOT NULL,
  job_number text NOT NULL,
  month date NOT NULL,
  company text,
  budget_labor numeric(18, 2),
  budget_hours numeric(12, 2),
  basis text NOT NULL CHECK (basis IN ('daily_budget', 'hours_budget_comparison', 'wage_by_job', 'gl_budget')),
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, job_number, month),
  CHECK (date_trunc('month', month)::date = month)
);

-- Aging snapshots (AR invoice aging and AP vendor aging exports). Kept per snapshot so DSO and
-- open balances can be shown as of a date instead of as of "now".
CREATE TABLE IF NOT EXISTS core.fact_ar_aging_snapshot (
  source text NOT NULL,
  snapshot_date date NOT NULL,
  company text NOT NULL DEFAULT '',
  customer_number text NOT NULL DEFAULT '',
  invoice_number text NOT NULL,
  customer_name text,
  parent_customer_number text,
  parent_customer_name text,
  job_number text,
  job_description text,
  invoice_date date,
  billing_period_from date,
  billing_period_to date,
  invoice_amount numeric(18, 2),
  amount_due numeric(18, 2),
  unapplied_cash numeric(18, 2),
  pending_payments numeric(18, 2),
  days_out integer,
  past_due_days integer,
  bucket_current numeric(18, 2),
  bucket_1_30 numeric(18, 2),
  bucket_31_60 numeric(18, 2),
  bucket_61_90 numeric(18, 2),
  bucket_90_plus numeric(18, 2),
  terms text,
  status text,
  is_collectible boolean NOT NULL DEFAULT true,
  PRIMARY KEY (source, snapshot_date, company, customer_number, invoice_number)
);
CREATE INDEX IF NOT EXISTS fact_ar_aging_snapshot_date_idx ON core.fact_ar_aging_snapshot (snapshot_date DESC);

CREATE TABLE IF NOT EXISTS core.fact_ap_aging_snapshot (
  source text NOT NULL,
  snapshot_date date NOT NULL,
  company text NOT NULL DEFAULT '',
  vendor_number text NOT NULL DEFAULT '',
  invoice_number text NOT NULL,
  invoice_entry_number text NOT NULL DEFAULT '',
  vendor_name text,
  vendor_type text,
  invoice_date date,
  due_date date,
  invoice_amount numeric(18, 2),
  amount_paid numeric(18, 2),
  balance numeric(18, 2),
  days_past_due integer,
  bucket_current numeric(18, 2),
  bucket_1_30 numeric(18, 2),
  bucket_31_60 numeric(18, 2),
  bucket_61_90 numeric(18, 2),
  bucket_90_plus numeric(18, 2),
  last_check_date date,
  permanent_hold boolean,
  PRIMARY KEY (source, snapshot_date, company, vendor_number, invoice_number, invoice_entry_number)
);
CREATE INDEX IF NOT EXISTS fact_ap_aging_snapshot_date_idx ON core.fact_ap_aging_snapshot (snapshot_date DESC);

-- Marts: company and cost breakdown.
ALTER TABLE mart.job_month
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'winteam_api',
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS delivery_model text,
  ADD COLUMN IF NOT EXISTS geo_precision text,
  ADD COLUMN IF NOT EXISTS payroll_ti_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subcontract_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplies_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_direct_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_direct_cost numeric(18, 2),
  ADD COLUMN IF NOT EXISTS budget_hours numeric(12, 2),
  ADD COLUMN IF NOT EXISTS revenue_basis text,
  ADD COLUMN IF NOT EXISTS labor_basis text,
  ADD COLUMN IF NOT EXISTS double_time_hours numeric(12, 2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS job_month_company_idx ON mart.job_month (company, month);

ALTER TABLE mart.portfolio_month
  ADD COLUMN IF NOT EXISTS payroll_ti_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subcontract_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplies_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_direct_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS direct_cost numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_direct_cost numeric(18, 2),
  ADD COLUMN IF NOT EXISTS double_time_hours numeric(12, 2) NOT NULL DEFAULT 0;

-- Settings the reference source relies on (tenant rules from Finance_Dashboard platform_config).
INSERT INTO ops.app_setting (key, value, description) VALUES
  ('account_groups', '[]'::jsonb,
   'Parent account grouping rules: [{name, terms:[], customer_terms:[], job_numbers:[]}], matched against job names and AR customer names (case-insensitive contains). Loaded from the Finance_Dashboard platform config.'),
  ('ar_treatment_rules', '[]'::jsonb,
   'Customers matched by these regexes ([{match, treatment, include_collectible_ar}]) are excluded from collectible AR (intercompany/settlement balances).'),
  ('company_aliases', '{"ServiceMaster by Crane IFS":"Crane IFS","Crane Integrated Facility Services Inc.":"Crane IFS","Crane West Opco LLC":"Crane West","Crane Southwest Opco LLC":"Crane Southwest","ServiceMaster by Sarus Co":"Sarus","Sarus Co LLC":"Sarus"}'::jsonb,
   'Raw WinTeam company names -> dashboard company labels.'),
  ('primary_source', '"winteam_api"'::jsonb,
   'Which source last filled the marts: winteam_api or finance_reference. Set by the loaders; read by the API source block.')
ON CONFLICT (key) DO NOTHING;
