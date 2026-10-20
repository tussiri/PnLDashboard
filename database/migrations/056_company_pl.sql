-- 056: the company P&L on Finance's basis (app/company_pl.py, docs/company-pl.md).
--
-- core.fact_job_income_statement_month holds the WinTeam Cross Tab Income Statement by job: every GL line
-- on every job for a month, each line classified into a category. It is the source of the full company
-- P&L: revenue, direct costs (labor, payroll taxes and insurance, subcontractors, supplies), operating
-- expenses on the jobs, and corporate overhead (the net cost of the overhead jobs in setting company_pl).
--
-- ops.pl_adjustment holds Finance's adjustments on top of the GL:
--   accrual  a cost (or revenue) not posted yet, added to a job for a month. Cleared when the real
--            invoice posts to the same month; or reversed in reverse_month when it posts later.
--   reclass  an amount moved from one job to another within a category (e.g. a management fee posted
--            to an overhead job that belongs to the customer).
--   staff    direct account staff: overhead charged to one P&L group before the pool is spread.
--
-- ops.job_contract holds monthly contract billing per job with an effective date, the 'contract'
-- invoice basis: a week's invoice is the contract in effect at the week's start ÷ the divisor.
--
-- Two invoice bases join last_month and run_rate_3m: latest_fixed_avg_variable (the latest month's
-- fixed billing plus the 3-month average variable billing) and contract.

CREATE TABLE IF NOT EXISTS core.fact_job_income_statement_month (
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  company text NOT NULL DEFAULT '',
  job_number text NOT NULL,
  job_name text,
  line text NOT NULL,
  label text,
  gl_account text,
  category text NOT NULL CHECK (category IN ('revenue', 'direct_labor', 'payroll_taxes_insurance', 'subcontractors',
                                             'supplies', 'other_direct', 'operating_expense')),
  amount numeric(18, 2) NOT NULL,
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  PRIMARY KEY (month, company, job_number, line)
);
CREATE INDEX IF NOT EXISTS fact_job_income_statement_month_job_idx
  ON core.fact_job_income_statement_month (company, job_number, month);

CREATE TABLE IF NOT EXISTS ops.pl_adjustment (
  adjustment_id bigserial PRIMARY KEY,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  kind text NOT NULL CHECK (kind IN ('accrual', 'reclass', 'staff')),
  category text NOT NULL CHECK (category IN ('revenue', 'direct_labor', 'payroll_taxes_insurance', 'subcontractors',
                                             'supplies', 'other_direct', 'operating_expense')),
  amount numeric(18, 2) NOT NULL,
  from_company text,
  from_job text,
  to_company text,
  to_job text,
  group_key text,
  description text NOT NULL,
  reverse_month date CHECK (reverse_month IS NULL OR extract(day FROM reverse_month) = 1),
  cleared_at timestamptz,
  cleared_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CHECK (kind <> 'accrual' OR to_job IS NOT NULL),
  CHECK (kind <> 'reclass' OR (from_job IS NOT NULL AND to_job IS NOT NULL)),
  CHECK (kind <> 'staff' OR group_key IS NOT NULL),
  CHECK (reverse_month IS NULL OR (kind = 'accrual' AND reverse_month > month))
);
CREATE INDEX IF NOT EXISTS pl_adjustment_month_idx ON ops.pl_adjustment (month);

CREATE TABLE IF NOT EXISTS ops.job_contract (
  company text NOT NULL,
  job_number text NOT NULL,
  effective_from date NOT NULL,
  monthly_amount numeric(18, 2) NOT NULL CHECK (monthly_amount >= 0),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (company, job_number, effective_from)
);

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_kind_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_kind_check
  CHECK (kind IN ('pay_report', 'job_cost', 'income_statement', 'service_feedback', 'qa_score', 'budget',
                  'job_income_statement', 'contract'));

ALTER TABLE ops.account DROP CONSTRAINT IF EXISTS account_invoice_basis_check;
ALTER TABLE ops.account ADD CONSTRAINT account_invoice_basis_check
  CHECK (invoice_basis IN ('last_month', 'run_rate_3m', 'latest_fixed_avg_variable', 'contract'));

-- Finance's weekly reports: FedEx bills the latest fixed fee plus the average OS billing; Crowley ISD bills
-- the month's contract (a job without a contract row falls back to the last closed month).
UPDATE ops.account SET invoice_basis = 'latest_fixed_avg_variable' WHERE slug = 'fedex' AND invoice_basis = 'run_rate_3m';
UPDATE ops.account SET invoice_basis = 'contract' WHERE slug = 'crowley-isd' AND invoice_basis = 'last_month';

INSERT INTO ops.app_setting (key, value, description)
VALUES ('company_pl',
        '{"overhead_jobs": ["6325", "63252", "63253"],
          "groups": [
            {"key": "fedex_subs", "name": "New FedEx subs", "accounts": ["fedex"], "delivery_model": "subcontracted", "fixed_monthly": 30000, "shares_pool": false},
            {"key": "education", "name": "Education", "accounts": ["plano-isd", "crowley-isd", "white-settlement-isd", "henderson-isd"], "fixed_monthly": 0, "shares_pool": true},
            {"key": "core", "name": "Amazon + other customers", "accounts": [], "rest": true, "fixed_monthly": 0, "shares_pool": true}
          ],
          "pool_basis": "revenue",
          "gl_categories": []}',
        'Company P&L (app/company_pl.py): the overhead jobs, the P&L groups (accounts, delivery model, fixed monthly overhead charge, whether the group shares the overhead pool), how the pool is spread, and GL account ranges that classify Cross Tab lines ([{from, to, category}]).')
ON CONFLICT (key) DO NOTHING;
