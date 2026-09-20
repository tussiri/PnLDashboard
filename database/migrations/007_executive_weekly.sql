-- 007: Executive weekly labor P&L (the "Labor P&L Dashboard" replica, docs/executive-pl.md).
--
-- Adds the two reference inputs the weekly view needs that the monthly marts do not carry
-- (daily labor budgets and admin-maintained contract billing), the weekly mart mart.job_week
-- (one row per job and Monday-based week, every value already apportioned to the week), and the
-- executive settings (BU targets / colours, the agency-sub allocation rule). Built by
-- app.weekly.rebuild at the end of every mart rebuild.

-- ---------------------------------------------------------------------------------------------
-- Daily labor budget by job (WinTeam tblJB_JOBS_Budgets_Daily export via the reference database).
-- Preferred weekly budget basis: summed over the week's days. Source agnostic.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.fact_daily_budget (
  source text NOT NULL,
  job_number text NOT NULL,
  budget_date date NOT NULL,
  company text,
  budgeted_dollars numeric(18, 2) NOT NULL DEFAULT 0,
  budgeted_hours numeric(12, 2) NOT NULL DEFAULT 0,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, job_number, budget_date)
);
CREATE INDEX IF NOT EXISTS fact_daily_budget_date_idx ON core.fact_daily_budget (budget_date);

-- ---------------------------------------------------------------------------------------------
-- Contract billing: the admin-maintained monthly contract amount per job (Finance_Dashboard
-- app.contract_billing). The latest effective_month <= a month wins for that month. Weekly
-- invoicing from it follows the 12/53 rule (monthly x 12/53 x week day-share).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.contract_billing (
  source text NOT NULL,
  job_number text NOT NULL,
  effective_month date NOT NULL,
  company text,
  monthly_amount numeric(18, 2) NOT NULL,
  notes text,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, job_number, effective_month),
  CHECK (date_trunc('month', effective_month)::date = effective_month)
);

-- ---------------------------------------------------------------------------------------------
-- Weekly mart: one row per (job, Monday week). Column rules live in app/weekly.py and
-- docs/executive-pl.md; every derived value carries its basis so the browser can disclose it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mart.job_week (
  job_key bigint NOT NULL REFERENCES core.dim_job(job_key),
  job_number text NOT NULL,
  site_name text,
  site_code text,                                   -- "Amazon - LGB3" -> "LGB3"; else the job name
  parent_account text,
  company text,                                     -- business unit
  delivery_model text,
  week_start date NOT NULL,                         -- Monday
  month_shares jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"YYYY-MM-01": {"days": n, "invoicing_basis": .., "budget_basis": .., "sub_basis": ..}}
  invoicing numeric(18, 2) NOT NULL DEFAULT 0,
  invoicing_basis text NOT NULL DEFAULT 'none'
    CHECK (invoicing_basis IN ('job_cost_month_prorated', 'contract', 'ar_invoice_prorated', 'none')),
  hours numeric(12, 2) NOT NULL DEFAULT 0,
  regular_hours numeric(12, 2) NOT NULL DEFAULT 0,
  ot_hours numeric(12, 2) NOT NULL DEFAULT 0,
  dt_hours numeric(12, 2) NOT NULL DEFAULT 0,
  direct_dollars numeric(18, 2) NOT NULL DEFAULT 0, -- straight time: sum(fact_timekeeping.labor_cost)
  ot_dollars numeric(18, 2) NOT NULL DEFAULT 0,     -- ESTIMATE: ot_hours x rate x 0.5 + dt_hours x rate x 1.0
  sub_dollars numeric(18, 2) NOT NULL DEFAULT 0,
  sub_estimated boolean NOT NULL DEFAULT false,
  sub_basis text NOT NULL DEFAULT 'none'
    CHECK (sub_basis IN ('job_cost', 'agency_ap', 'carry_forward', 'none')),
  total_dollars numeric(18, 2) NOT NULL DEFAULT 0,  -- direct + ot + sub
  budget_hours numeric(12, 2),
  budget_dollars numeric(18, 2),
  budget_basis text NOT NULL DEFAULT 'none' CHECK (budget_basis IN ('daily_budget', 'hbc', 'none')),
  labor_cost_basis text,
  days_with_labor integer NOT NULL DEFAULT 0,
  rebuilt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_key, week_start),
  CHECK (extract(isodow FROM week_start) = 1)
);
CREATE INDEX IF NOT EXISTS job_week_week_idx ON mart.job_week (week_start);
CREATE INDEX IF NOT EXISTS job_week_account_idx ON mart.job_week (parent_account, week_start);

ALTER TABLE mart.rebuild_log ADD COLUMN IF NOT EXISTS job_week_rows integer;

-- ---------------------------------------------------------------------------------------------
-- Executive settings (editable through the admin API; defaults from the original dashboard).
-- ---------------------------------------------------------------------------------------------
INSERT INTO ops.app_setting (key, value, description) VALUES
  ('bu_targets',
   '{"Crane West":{"target":59.5,"high":65},"Crane IFS":{"target":64.5,"high":70},"Crane Southwest":{"target":64.5,"high":70},"Sarus":{"target":64.5,"high":70}}'::jsonb,
   'Executive labor P&L: labor % of invoicing per business unit (company). target = green ceiling, high = warning ceiling; above high is severe.'),
  ('bu_colors',
   '{"Crane West":"#378ADD","Crane IFS":"#1F9E89","Crane Southwest":"#D97706","Sarus":"#7C3AED"}'::jsonb,
   'Executive labor P&L: colour per business unit.'),
  ('agency_sub',
   '{"vendor_match":"km group","pct":0.70,"site_jobs":{"LGB3":"500","APC2":"505","PSP3":"504"}}'::jsonb,
   'Executive labor P&L agency-sub rule: AP invoices of the vendor (name contains vendor_match) whose invoice number starts with a site code are allocated x pct to that site''s job, by invoice month, apportioned to weeks by calendar days.'),
  ('ot_bands', '{"warn":8.0,"severe":15.0}'::jsonb,
   'Executive labor P&L: overtime % of hours warning / severe thresholds.')
ON CONFLICT (key) DO NOTHING;
