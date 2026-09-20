-- 003: Normalized contract for the documented WinTeam (TEAM Concourse "wtnextgen") GET endpoints.
--
-- Source of truth for field names: WinTeamAPI.txt (Timekeeping v2, Jobs v2 incl. GL budgets and
-- schedules, Accounts v1 payables/receivables/payments, Vendors v1). Every column below maps to a
-- documented response field; derived columns are named as such and their rule is recorded in
-- ops.app_setting so the dashboard can disclose it.

-- ---------------------------------------------------------------------------------------------
-- Application settings (server-side, editable through the admin API; defaults seeded here)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.app_setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO ops.app_setting (key, value, description) VALUES
  ('payroll_burden_rate', '0'::jsonb,
   'Fraction of timekeeping labor cost added as payroll taxes/insurance burden (0 = report labor margin only).'),
  ('overtime_weekly_threshold_hours', '40'::jsonb,
   'Hours per employee per pay week (Sun-Sat) above which derived overtime is counted when no overtime category ids are configured.'),
  ('overtime_category_detail_ids', '[]'::jsonb,
   'Timekeeping categoryDetailId values that the tenant confirms represent overtime. Empty = derive by weekly threshold.'),
  ('fiscal_year_start_month', '1'::jsonb,
   'Calendar month (1-12) in which GL budget period1 falls.'),
  ('gl_account_classes', '{"revenue":{"ranges":[[3000,3999],[30000,39999]],"keywords":["income","revenue","sales"]},"direct_labor":{"ranges":[],"keywords":["labor","wages","payroll"]},"subcontract":{"ranges":[[44000,44999]],"keywords":["subcontract"]},"supplies":{"ranges":[],"keywords":["suppl","material","chemical"]}}'::jsonb,
   'How GL budget accounts are classified into revenue / direct labor / subcontract / supplies for budget vs actual.'),
  ('job_tier_map', '{"region":1,"branch":2,"service_type":3,"manager":4,"vertical":6}'::jsonb,
   'Which WinTeam job tier id populates each dashboard dimension. Tenant specific; confirm in WinTeam job setup.'),
  ('customer_names', '{}'::jsonb,
   'Optional map of WinTeam customerNumber -> display name (the receivables endpoint returns numbers only).'),
  ('close_lag_days', '5'::jsonb,
   'A month is treated as closed for forecasting once this many days have passed after month end and it carries revenue.'),
  ('margin_target_pct', '0.25'::jsonb,
   'Target gross margin used by exceptions and profitability views.'),
  ('labor_target_pct', '0.47'::jsonb,
   'Target labor cost as a share of revenue used by labor views.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- Jobs (GET /jobs/v2/api/jobs)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE core.dim_job
  ADD COLUMN IF NOT EXISTS company_number integer,
  ADD COLUMN IF NOT EXISTS location_id integer,
  ADD COLUMN IF NOT EXISTS parent_job_number text,
  ADD COLUMN IF NOT EXISTS type_id integer,
  ADD COLUMN IF NOT EXISTS supervisor_id integer,
  ADD COLUMN IF NOT EXISTS hours_rule_id integer,
  ADD COLUMN IF NOT EXISTS hours_category_id integer,
  ADD COLUMN IF NOT EXISTS taxes_insurance_id integer,
  ADD COLUMN IF NOT EXISTS date_to_start date,
  ADD COLUMN IF NOT EXISTS manager_name text,
  ADD COLUMN IF NOT EXISTS vertical text,
  ADD COLUMN IF NOT EXISTS address_line_2 text,
  ADD COLUMN IF NOT EXISTS tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS dim_job_current_job_number_idx
  ON core.dim_job (job_number) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS core.job_tier (
  job_key bigint NOT NULL REFERENCES core.dim_job(job_key) ON DELETE CASCADE,
  tier_id integer NOT NULL,
  tier_value integer,
  tier_description text,
  PRIMARY KEY (job_key, tier_id)
);

-- ---------------------------------------------------------------------------------------------
-- Customers (numbers come from receivables invoices; names are tenant supplied)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.dim_customer (
  customer_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_number text NOT NULL UNIQUE,
  customer_name text,
  parent_account_key bigint REFERENCES core.dim_parent_account(parent_account_key),
  source text NOT NULL DEFAULT 'winteam' CHECK (source IN ('winteam', 'manual', 'config')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  warehouse_updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Timekeeping (GET /timekeeping/v2/api/timekeeping)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE core.fact_timekeeping
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS hours numeric(10, 2),
  ADD COLUMN IF NOT EXISTS category_detail_id integer,
  ADD COLUMN IF NOT EXISTS rate numeric(12, 4),
  ADD COLUMN IF NOT EXISTS in_time timestamptz,
  ADD COLUMN IF NOT EXISTS out_time timestamptz,
  ADD COLUMN IF NOT EXISTS lunch numeric(6, 2),
  ADD COLUMN IF NOT EXISTS work_ticket_number text,
  ADD COLUMN IF NOT EXISTS pay_week_start date,
  ADD COLUMN IF NOT EXISTS overtime_basis text
    CHECK (overtime_basis IS NULL OR overtime_basis IN ('category', 'weekly_threshold', 'none'));

CREATE INDEX IF NOT EXISTS fact_timekeeping_job_number_date_idx
  ON core.fact_timekeeping (job_number, work_date DESC);
CREATE INDEX IF NOT EXISTS fact_timekeeping_employee_week_idx
  ON core.fact_timekeeping (employee_source_id, pay_week_start);

-- ---------------------------------------------------------------------------------------------
-- Job schedules (GET /jobs/v2/api/jobs/{jobKey}/schedules)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.fact_schedule (
  schedule_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL UNIQUE,
  schedule_details_id integer,
  job_post_detail_id integer,
  job_key bigint REFERENCES core.dim_job(job_key),
  job_number text,
  employee_source_id text,
  work_date date NOT NULL,
  in_time timestamptz,
  out_time timestamptz,
  hours numeric(10, 2),
  lunch numeric(6, 2),
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (hours IS NULL OR hours >= 0)
);

CREATE INDEX IF NOT EXISTS fact_schedule_job_date_idx
  ON core.fact_schedule (job_number, work_date DESC);

-- ---------------------------------------------------------------------------------------------
-- GL budgets (GET /jobs/v2/api/jobs/{jobKey}/gl-budgets)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.fact_gl_budget (
  gl_budget_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL UNIQUE,            -- jobNumber:fiscalYear:glBudgetDetailId
  job_key bigint REFERENCES core.dim_job(job_key),
  job_number text NOT NULL,
  fiscal_year integer NOT NULL,
  gl_budget_id integer,
  gl_budget_detail_id integer,
  gl_account_number integer,
  gl_account_description text,
  financial_statement smallint,
  job_cost_analysis smallint,
  budget_total numeric(18, 2),
  period_amounts numeric(18, 2)[] NOT NULL DEFAULT '{}',
  account_class text NOT NULL DEFAULT 'other'
    CHECK (account_class IN ('revenue', 'direct_labor', 'subcontract', 'supplies', 'other')),
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fact_gl_budget_job_year_idx
  ON core.fact_gl_budget (job_number, fiscal_year);

CREATE TABLE IF NOT EXISTS core.fact_gl_budget_month (
  gl_budget_key bigint NOT NULL REFERENCES core.fact_gl_budget(gl_budget_key) ON DELETE CASCADE,
  period_no smallint NOT NULL CHECK (period_no BETWEEN 1 AND 12),
  budget_month date NOT NULL,
  amount numeric(18, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (gl_budget_key, period_no),
  CHECK (date_trunc('month', budget_month)::date = budget_month)
);

CREATE INDEX IF NOT EXISTS fact_gl_budget_month_month_idx
  ON core.fact_gl_budget_month (budget_month);

-- ---------------------------------------------------------------------------------------------
-- Vendors (GET /vendors/v1/api/vendors)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE core.dim_vendor
  ADD COLUMN IF NOT EXISTS vendor_number integer,
  ADD COLUMN IF NOT EXISTS vendor_type_id integer,
  ADD COLUMN IF NOT EXISTS parent_vendor_number integer,
  ADD COLUMN IF NOT EXISTS account_number text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address jsonb,
  ADD COLUMN IF NOT EXISTS contacts jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS dim_vendor_number_idx ON core.dim_vendor (vendor_number);

-- ---------------------------------------------------------------------------------------------
-- Accounts payable invoices (GET /accounts/v1/api/payables/invoices)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.fact_ap_invoice (
  ap_invoice_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL UNIQUE,            -- companyNumber:vendorNumber:invoiceNumber
  vendor_key bigint REFERENCES core.dim_vendor(vendor_key),
  vendor_number integer,
  company_number integer,
  invoice_number text NOT NULL,
  invoice_date date,
  posting_date date,
  due_date date,
  invoice_amount numeric(18, 2),
  po_number text,
  notes text,
  pay_use_tax boolean,
  use_tax_amount numeric(18, 2),
  use_tax_code text,
  payment_plan_id integer,
  payment_method_id integer,
  credit_card_vendor_number integer,
  memo_line_1 text,
  memo_line_2 text,
  permanent_hold boolean,
  include_on_1099 boolean,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fact_ap_invoice_vendor_date_idx
  ON core.fact_ap_invoice (vendor_number, invoice_date DESC);
CREATE INDEX IF NOT EXISTS fact_ap_invoice_due_idx ON core.fact_ap_invoice (due_date);

-- ---------------------------------------------------------------------------------------------
-- Accounts receivable invoices (GET /accounts/v1/api/receivables/invoices/?customerNumber=)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.fact_ar_invoice (
  ar_invoice_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL UNIQUE,            -- customerNumber:invoiceNumber
  customer_key bigint REFERENCES core.dim_customer(customer_key),
  customer_number text NOT NULL,
  invoice_number text NOT NULL,
  job_key bigint REFERENCES core.dim_job(job_key),
  job_number text,
  invoice_date date,
  posting_date date,
  billing_period_from date,
  billing_period_to date,
  service_month date,                          -- derived: month of billing_period_from, else invoice_date
  terms text,
  terms_id integer,
  sales_rep text,
  sales_rep_id integer,
  po_number text,
  reason text,
  reason_id integer,
  notes text,
  tax numeric(18, 2),
  amount_paid numeric(18, 2),
  revenue_total numeric(18, 2),
  invoice_total numeric(18, 2),
  last_date_paid date,
  collection_status text,
  invoice_being_credited text,
  open_balance numeric(18, 2) GENERATED ALWAYS AS (coalesce(invoice_total, 0) - coalesce(amount_paid, 0)) STORED,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (service_month IS NULL OR date_trunc('month', service_month)::date = service_month)
);

CREATE INDEX IF NOT EXISTS fact_ar_invoice_job_month_idx ON core.fact_ar_invoice (job_number, service_month);
CREATE INDEX IF NOT EXISTS fact_ar_invoice_customer_idx ON core.fact_ar_invoice (customer_number, invoice_date DESC);

-- ---------------------------------------------------------------------------------------------
-- Accounts payable payments (GET /accounts/v1/api/payables/payments)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.fact_ap_payment (
  ap_payment_key bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  winteam_id text NOT NULL UNIQUE,            -- paymentId
  payment_method_id integer,
  payment_method text,
  check_number text,
  check_date date,
  payment_date_added date,
  payment_date date,                           -- derived: check_date, else payment_date_added
  amount numeric(18, 2),
  company_number integer,
  company_name text,
  gl_cash_account integer,
  payee_type_id integer,
  payee_type text,
  vendor_key bigint REFERENCES core.dim_vendor(vendor_key),
  vendor_number integer,
  vendor_name text,
  other_vendor_id text,
  other_vendor_name text,
  apply_to_expenses boolean,
  is_system_generated boolean,
  external_system_id text,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fact_ap_payment_date_idx ON core.fact_ap_payment (payment_date DESC);

-- ---------------------------------------------------------------------------------------------
-- Reporting marts (rebuilt by the API service after each sync; tables so Metabase can index them)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mart.job_month (
  job_key bigint NOT NULL REFERENCES core.dim_job(job_key),
  job_number text NOT NULL,
  job_name text,
  parent_account text,
  customer_number text,
  region text,
  branch text,
  service_type text,
  vertical text,
  manager_name text,
  city text,
  state_province text,
  country_code char(2),
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  month date NOT NULL,
  revenue numeric(18, 2) NOT NULL DEFAULT 0,        -- AR revenueTotal attributed to service_month
  invoiced_total numeric(18, 2) NOT NULL DEFAULT 0, -- AR invoiceTotal attributed to service_month
  collected_total numeric(18, 2) NOT NULL DEFAULT 0,-- AR amountPaid on invoices attributed to service_month
  invoice_count integer NOT NULL DEFAULT 0,
  hours numeric(12, 2) NOT NULL DEFAULT 0,
  regular_hours numeric(12, 2) NOT NULL DEFAULT 0,
  overtime_hours numeric(12, 2) NOT NULL DEFAULT 0,
  labor_cost numeric(18, 2) NOT NULL DEFAULT 0,     -- sum(hours * rate)
  burden_cost numeric(18, 2) NOT NULL DEFAULT 0,    -- labor_cost * payroll_burden_rate
  direct_cost numeric(18, 2) NOT NULL DEFAULT 0,    -- labor_cost + burden_cost
  gross_profit numeric(18, 2) NOT NULL DEFAULT 0,   -- revenue - direct_cost
  gross_margin_pct numeric(9, 4),
  scheduled_hours numeric(12, 2) NOT NULL DEFAULT 0,
  budget_revenue numeric(18, 2),
  budget_labor numeric(18, 2),
  budget_subcontract numeric(18, 2),
  budget_supplies numeric(18, 2),
  employee_count integer NOT NULL DEFAULT 0,
  work_days integer NOT NULL DEFAULT 0,
  last_work_date date,
  data_quality_status text NOT NULL DEFAULT 'passed' CHECK (data_quality_status IN ('passed', 'warning')),
  quality_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  rebuilt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_key, month),
  CHECK (date_trunc('month', month)::date = month)
);

CREATE INDEX IF NOT EXISTS job_month_month_idx ON mart.job_month (month);
CREATE INDEX IF NOT EXISTS job_month_account_idx ON mart.job_month (parent_account, month);

CREATE TABLE IF NOT EXISTS mart.portfolio_month (
  month date PRIMARY KEY,
  jobs_reporting integer NOT NULL DEFAULT 0,
  revenue numeric(18, 2) NOT NULL DEFAULT 0,
  invoiced_total numeric(18, 2) NOT NULL DEFAULT 0,
  collected_total numeric(18, 2) NOT NULL DEFAULT 0,
  hours numeric(12, 2) NOT NULL DEFAULT 0,
  regular_hours numeric(12, 2) NOT NULL DEFAULT 0,
  overtime_hours numeric(12, 2) NOT NULL DEFAULT 0,
  labor_cost numeric(18, 2) NOT NULL DEFAULT 0,
  burden_cost numeric(18, 2) NOT NULL DEFAULT 0,
  gross_profit numeric(18, 2) NOT NULL DEFAULT 0,
  scheduled_hours numeric(12, 2) NOT NULL DEFAULT 0,
  budget_revenue numeric(18, 2),
  budget_labor numeric(18, 2),
  ap_invoiced numeric(18, 2) NOT NULL DEFAULT 0,
  ap_paid numeric(18, 2) NOT NULL DEFAULT 0,
  rebuilt_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_trunc('month', month)::date = month)
);

CREATE TABLE IF NOT EXISTS mart.rebuild_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  job_month_rows integer,
  portfolio_month_rows integer,
  forecast_rows integer,
  error_message text
);

-- Open receivables as of now (the receivables endpoint exposes invoiceTotal and amountPaid only).
CREATE OR REPLACE VIEW mart.v_ar_open AS
SELECT
  i.ar_invoice_key,
  i.customer_number,
  coalesce(c.customer_name, 'Customer ' || i.customer_number) AS customer_name,
  i.invoice_number,
  i.job_number,
  j.job_name,
  j.parent_account_key,
  pa.account_name AS parent_account,
  i.invoice_date,
  i.terms,
  i.invoice_total,
  i.amount_paid,
  i.open_balance,
  i.collection_status,
  (current_date - i.invoice_date) AS days_outstanding,
  CASE
    WHEN i.invoice_date IS NULL THEN 'unknown'
    WHEN current_date - i.invoice_date <= 30 THEN 'current'
    WHEN current_date - i.invoice_date <= 60 THEN 'd30'
    WHEN current_date - i.invoice_date <= 90 THEN 'd60'
    WHEN current_date - i.invoice_date <= 120 THEN 'd90'
    ELSE 'd90_plus'
  END AS aging_bucket
FROM core.fact_ar_invoice i
LEFT JOIN core.dim_customer c ON c.customer_number = i.customer_number
LEFT JOIN core.dim_job j ON j.job_key = i.job_key
LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
WHERE coalesce(i.invoice_total, 0) - coalesce(i.amount_paid, 0) > 0.005;

CREATE OR REPLACE VIEW mart.v_timekeeping_daily AS
SELECT
  t.job_number,
  t.job_key,
  t.work_date,
  sum(t.hours) AS hours,
  sum(t.regular_hours) AS regular_hours,
  sum(t.overtime_hours) AS overtime_hours,
  sum(t.labor_cost) AS labor_cost,
  count(DISTINCT t.employee_source_id) AS employees,
  count(*) AS punches
FROM core.fact_timekeeping t
GROUP BY t.job_number, t.job_key, t.work_date;

CREATE OR REPLACE VIEW mart.v_ap_vendor_month AS
SELECT
  date_trunc('month', coalesce(i.invoice_date, i.posting_date))::date AS month,
  i.vendor_number,
  coalesce(v.vendor_name, 'Vendor ' || i.vendor_number::text) AS vendor_name,
  count(*) AS invoice_count,
  sum(i.invoice_amount) AS invoiced
FROM core.fact_ap_invoice i
LEFT JOIN core.dim_vendor v ON v.vendor_number = i.vendor_number
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW mart.v_ap_payment_month AS
SELECT
  date_trunc('month', p.payment_date)::date AS month,
  p.vendor_number,
  coalesce(p.vendor_name, v.vendor_name) AS vendor_name,
  p.payment_method,
  count(*) AS payment_count,
  sum(p.amount) AS paid
FROM core.fact_ap_payment p
LEFT JOIN core.dim_vendor v ON v.vendor_number = p.vendor_number
GROUP BY 1, 2, 3, 4;
