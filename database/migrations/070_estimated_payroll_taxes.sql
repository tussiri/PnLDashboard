-- Estimated payroll taxes and insurance (app/marts.py).
-- The job cost export carries no payroll tax or insurance lines (GL 41000-42999) and the live months carry
-- timekeeping wages only, so payroll_ti_cost read 0. A job-month with labor and no actual payroll taxes now
-- carries labor x the month's burden rate (app/allocations.py: the Trend Income Statement's payroll taxes and
-- workers comp / wages, the latest statement month at or before it, or a manual monthly rate), included in
-- payroll_ti_cost, direct_cost and gross_profit and recorded here so the views label it as an estimate.
ALTER TABLE mart.job_month ADD COLUMN IF NOT EXISTS payroll_ti_estimated numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE mart.portfolio_month ADD COLUMN IF NOT EXISTS payroll_ti_estimated numeric(18, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN mart.job_month.payroll_ti_estimated IS
  'The part of payroll_ti_cost that is estimated: labor_cost x the month''s burden rate where the job-month has no actual payroll taxes and insurance; 0 otherwise.';
COMMENT ON COLUMN mart.portfolio_month.payroll_ti_estimated IS
  'Sum of mart.job_month.payroll_ti_estimated.';
