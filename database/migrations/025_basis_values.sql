-- 025: admit the two new basis values.
--
-- invoicing_basis gains 'mixed', for a week whose month slices genuinely disagree (migration 023).
-- budget_basis gains 'job_budget', the WinTeam job budgets endpoint - budgeted hours per day of
-- week and the pay rate behind them (migration 024), which is the first live budget source this
-- tenant has had: gl-budgets returns nothing and the export-fed daily budget stopped in July 2026.
--
-- The constraints are the reason a basis cannot be invented silently, so they are widened
-- deliberately rather than dropped.
ALTER TABLE mart.job_week DROP CONSTRAINT IF EXISTS job_week_invoicing_basis_check;
ALTER TABLE mart.job_week ADD CONSTRAINT job_week_invoicing_basis_check
  CHECK (invoicing_basis = ANY (ARRAY['job_cost_month_prorated', 'contract', 'ar_invoice_prorated',
                                      'carry_forward', 'mixed', 'none']));

ALTER TABLE mart.job_week DROP CONSTRAINT IF EXISTS job_week_budget_basis_check;
ALTER TABLE mart.job_week ADD CONSTRAINT job_week_budget_basis_check
  CHECK (budget_basis = ANY (ARRAY['daily_budget', 'job_budget', 'hbc', 'none']));
