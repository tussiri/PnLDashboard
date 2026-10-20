-- 057: the company P&L built the way finance builds it (app/company_pnl.py).
--
-- * core.fact_job_income_statement_month: WinTeam's Cross Tab Income Statement by job, one row per
--   company, job, month and GL account (import kind job_income_statement). It carries every GL line on a
--   job (payroll taxes, insurance, supplies, other operating expenses), which the Job Cost Analysis
--   export leaves out, so a month with it loaded has complete job margins.
-- * ops.pnl_adjustment: accruals and reclasses entered by finance, kept visible and reversible.
--   An accrual adds cost (or revenue) to a job for a month: a sub invoice not posted yet, at the
--   expected amount. With auto_reverse it stops counting once that job's actual amount on the line has
--   risen by 90% of the accrual over `baseline`, the amount when the accrual was entered (the invoice
--   posted; FedEx subs send a second invoice at month end, so "any cost posted" is not enough). A reclass moves an amount of revenue or cost from one
--   job to another for a month (coded to the wrong job).
-- * ops.pnl_group_month: a month's fixed overhead charge and direct account staff per P&L group,
--   overriding the 'company_pnl' setting (groups, the overhead jobs and the overhead rule).
-- * import kind contract_billing: the contract schedule per job and month (core.contract_billing,
--   migration 007), the weekly invoice basis of accounts whose invoice_basis is 'contract'.

CREATE TABLE IF NOT EXISTS core.fact_job_income_statement_month (
  company text NOT NULL,
  job_number text NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  gl_account integer NOT NULL,
  gl_description text,
  job_name text,
  amount numeric(18, 2) NOT NULL,
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, job_number, month, gl_account)
);
CREATE INDEX IF NOT EXISTS fact_job_income_statement_month_idx ON core.fact_job_income_statement_month (month);

COMMENT ON TABLE core.fact_job_income_statement_month IS
  'WinTeam Cross Tab Income Statement by job: GL amounts per company, job and month. Revenue GLs positive, costs positive. A file replaces the companies and months it covers.';

CREATE TABLE IF NOT EXISTS ops.pnl_adjustment (
  adjustment_id bigserial PRIMARY KEY,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  kind text NOT NULL CHECK (kind IN ('accrual', 'reclass')),
  line text NOT NULL CHECK (line IN ('revenue', 'labor', 'payroll_taxes', 'subcontractors', 'supplies', 'other')),
  company text NOT NULL,
  job_number text NOT NULL,
  to_company text,
  to_job_number text,
  amount numeric(18, 2) NOT NULL,
  auto_reverse boolean NOT NULL DEFAULT true,
  baseline numeric(18, 2),
  note text,
  reversed_at timestamptz,
  reversed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CHECK ((kind = 'reclass') = (to_job_number IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pnl_adjustment_month_idx ON ops.pnl_adjustment (month);

COMMENT ON TABLE ops.pnl_adjustment IS
  'Finance adjustments to the company P&L: accruals (cost or revenue expected but not posted; with auto_reverse they stop counting once the job''s actual amount on that line posts) and reclasses (move an amount from one job to another). Reversing keeps the row.';

CREATE TABLE IF NOT EXISTS ops.pnl_group_month (
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  group_key text NOT NULL,
  fixed_charge numeric(18, 2),
  direct_staff numeric(18, 2),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (month, group_key)
);

INSERT INTO ops.app_setting (key, value, description)
VALUES ('company_pnl',
        '{"overhead_jobs": ["6325", "63252", "63253"],
          "groups": [
            {"key": "fedex_subs", "name": "New FedEx subs", "accounts": ["fedex"], "delivery_model": "subcontracted",
             "fixed_charge": 30000, "direct_staff": 15000, "shares_pool": false},
            {"key": "education", "name": "Education", "accounts": ["plano-isd", "crowley-isd", "white-settlement-isd", "henderson-isd"],
             "fixed_charge": 0, "direct_staff": 0, "shares_pool": true},
            {"key": "core", "name": "Amazon + other customers", "accounts": [], "default": true,
             "fixed_charge": 0, "direct_staff": 0, "shares_pool": true}
          ]}',
        'Company P&L groups and the overhead rule (app/company_pnl.py)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_kind_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_kind_check
  CHECK (kind IN ('pay_report', 'job_cost', 'income_statement', 'service_feedback', 'qa_score', 'budget',
                  'job_income_statement', 'contract_billing'));

-- Weekly invoice basis 'contract': the contract schedule's amount for the week's month ÷ the divisor
-- (Crowley ISD bills a fixed contract by facility, and finance's weekly report invoices from it). A job
-- with no contract row for the month falls back to the last closed month.
ALTER TABLE ops.account DROP CONSTRAINT IF EXISTS account_invoice_basis_check;
ALTER TABLE ops.account ADD CONSTRAINT account_invoice_basis_check
  CHECK (invoice_basis IN ('last_month', 'run_rate_3m', 'contract'));
UPDATE ops.account SET invoice_basis = 'contract' WHERE slug = 'crowley-isd' AND invoice_basis = 'last_month';
