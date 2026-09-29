-- 037: what each account's weekly report needs (the FedEx and Amazon Labor P&L reports).
--
-- ops.account
--   vocabulary           which report's words the account's pages use: 'amazon' (Invoicing, On track /
--                        High, Hours to cut) or 'fedex' (Weekly invoice, On target / Over, Over Target).
--   vendor_factor        share of agency or subcontractor cost counted in labor (both reports: 70%).
--   invoice_basis        weekly invoice from the last closed month, or the 3-month run rate ÷ divisor.
--   group_by             groups by segment, or 'pallet': Pallet sites vs Janitorial only.
--   split_subcontracted  subcontracted sites leave the labor views for their own AR / AP tab.
-- ops.account_job.role 'pallet': a pallet job (WinTeam child job named "... Pallet") rolled into its
--   parent site, where its labor and hours show as the pallet share.
-- core.fact_job_cost_month.revenue_fixed / revenue_variable: the Job Cost Analysis revenue lines
--   (fixed contract billing vs variable / OS billing such as pallets), when the export carries them.
-- core.fact_income_statement_month: Trend Income Statement lines per account and month (import kind
--   'income_statement'), for the Income Statement tab and its bridge to the dashboard sites.

ALTER TABLE ops.account
  ADD COLUMN IF NOT EXISTS vocabulary text NOT NULL DEFAULT 'amazon' CHECK (vocabulary IN ('amazon', 'fedex')),
  ADD COLUMN IF NOT EXISTS vendor_factor numeric(5, 4) NOT NULL DEFAULT 1 CHECK (vendor_factor >= 0 AND vendor_factor <= 1),
  ADD COLUMN IF NOT EXISTS invoice_basis text NOT NULL DEFAULT 'last_month' CHECK (invoice_basis IN ('last_month', 'run_rate_3m')),
  ADD COLUMN IF NOT EXISTS group_by text NOT NULL DEFAULT 'segment' CHECK (group_by IN ('segment', 'pallet')),
  ADD COLUMN IF NOT EXISTS split_subcontracted boolean NOT NULL DEFAULT false;

UPDATE ops.account
SET vocabulary = 'fedex', vendor_factor = 0.70, invoice_basis = 'run_rate_3m', group_by = 'pallet', split_subcontracted = true
WHERE slug = 'fedex';
UPDATE ops.account SET vendor_factor = 0.70 WHERE slug = 'amazon';

ALTER TABLE ops.account_job DROP CONSTRAINT IF EXISTS account_job_role_check;
ALTER TABLE ops.account_job ADD CONSTRAINT account_job_role_check CHECK (role IN ('site', 'catch_all', 'non_billed', 'pallet'));

UPDATE ops.account_job aj
SET role = 'pallet'
FROM core.dim_job j, ops.account_job parent
WHERE j.company = aj.company AND j.job_number = aj.job_number
  AND j.job_name ~* 'pallet\s*$' AND j.parent_job_number IS NOT NULL
  AND parent.company = aj.company AND parent.job_number = j.parent_job_number AND parent.account_slug = aj.account_slug
  AND aj.role = 'site';

ALTER TABLE core.fact_job_cost_month
  ADD COLUMN IF NOT EXISTS revenue_fixed numeric(18, 2),
  ADD COLUMN IF NOT EXISTS revenue_variable numeric(18, 2);

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_kind_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_kind_check CHECK (kind IN ('pay_report', 'job_cost', 'income_statement'));

CREATE TABLE IF NOT EXISTS core.fact_income_statement_month (
  account_slug text NOT NULL REFERENCES ops.account (slug) ON UPDATE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  line text NOT NULL,
  amount numeric(18, 2) NOT NULL,
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  PRIMARY KEY (account_slug, month, line)
);
