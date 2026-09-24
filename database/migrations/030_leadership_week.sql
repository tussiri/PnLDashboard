-- 030: mart.leadership_week, the weekly labor P&L behind the leadership views (app/leadership.py).
--
-- One row per job and Monday week. Labor, hours and overtime come from the imported Pay Report when
-- the company's pay report covers the week (labor_basis 'pay_report'), else from mart.job_week's
-- trailing-rate estimate ('trailing_rate_estimate'). revenue_month is the latest closed job-cost month
-- before the month the week ends in; revenue_month_amount is that month's revenue for the job, the
-- basis of the weekly invoice (monthly revenue / the account's divisor). prior_* describe the same
-- month: labor from the pay report when it covers the whole month, else the job-cost direct labor;
-- subcontract = the greater of the job-cost line and AP invoices coded to the job (a partial job-cost
-- export can miss vendor bills). sub_week is mart.job_week's vendor cost, shown beside labor for
-- subcontracted sites and never added into labor %.
-- Consumables stay null until a capture method exists (docs/consumables-strategy.md).

CREATE TABLE IF NOT EXISTS mart.leadership_week (
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  week_end date NOT NULL,
  job_key bigint NOT NULL,
  company text,
  job_number text NOT NULL,
  site_name text,
  parent_account text,
  account_slug text,
  segment text,
  role text NOT NULL DEFAULT 'site',
  needs_review boolean NOT NULL DEFAULT false,
  hours numeric(12, 2) NOT NULL DEFAULT 0,
  ot_hours numeric(12, 2) NOT NULL DEFAULT 0,
  labor numeric(14, 2) NOT NULL DEFAULT 0,
  labor_basis text NOT NULL,
  ot_dollars numeric(14, 2) NOT NULL DEFAULT 0,
  budget_hours numeric(12, 2) NOT NULL DEFAULT 0,
  budget_dollars numeric(14, 2) NOT NULL DEFAULT 0,
  employees integer NOT NULL DEFAULT 0,
  days_with_labor integer NOT NULL DEFAULT 0,
  revenue_month date,
  revenue_month_amount numeric(14, 2) NOT NULL DEFAULT 0,
  revenue_month_basis text,
  invoice_week numeric(14, 2),
  prior_revenue numeric(14, 2) NOT NULL DEFAULT 0,
  prior_labor numeric(14, 2) NOT NULL DEFAULT 0,
  prior_labor_basis text,
  prior_sub numeric(14, 2) NOT NULL DEFAULT 0,
  prior_sub_basis text,
  delivery_model text,
  sub_week numeric(14, 2) NOT NULL DEFAULT 0,
  sub_week_basis text,
  consumables_cost numeric(14, 2),
  consumables_basis text CHECK (consumables_basis IS NULL OR consumables_basis IN ('actual', 'estimate')),
  rebuilt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_key, week_start)
);
CREATE INDEX IF NOT EXISTS leadership_week_account_idx ON mart.leadership_week (week_start, account_slug);

COMMENT ON TABLE mart.leadership_week IS
  'Weekly labor P&L rows for the leadership views. labor_basis: pay_report | trailing_rate_estimate. ot_dollars is full overtime pay (1.5x). account_slug null = Other.';
