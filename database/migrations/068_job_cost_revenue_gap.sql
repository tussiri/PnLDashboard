-- 068: AR revenue that the job-cost export leaves out (app/revenue_gap.py).
--
-- From July 2026 Crane's Job Cost Analysis export (WinTeam report FormatID 3) omits the revenue GL accounts
-- 31808 "JANITORIAL: Indstrl, Mnftng, Wrhs - Subcontracted" and 34001 "JANITORIAL: OS Project Revenue". A job
-- with no job-cost revenue already falls back to its AR invoices, but a job with some job-cost revenue (the
-- fixed fee on 31800) loses the rest: July 2026 $516K and August $902K short of AR across FedEx, Amazon and an
-- overhead job. Each mart rebuild adds the shortfall back to mart.job_month.revenue (and gross_profit), recorded
-- in revenue_ar_gap, reconciled per parent account so AR billed to a parent job (Plano ISD, Crowley ISD) that job
-- cost spreads over other jobs is not counted twice. revenue_basis stays 'job_cost': the month is still closed.
ALTER TABLE mart.job_month ADD COLUMN IF NOT EXISTS revenue_ar_gap numeric(18,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN mart.job_month.revenue_ar_gap IS
  'AR invoice revenue added to a job-cost month whose export omits revenue GL accounts (app/revenue_gap.py); included in revenue and gross_profit.';

INSERT INTO ops.app_setting (key, value, description)
VALUES ('job_cost_revenue_gap', '{"from": "2026-07-01", "until": null}'::jsonb,
        'Job-cost months from `from` up to (not including) `until` miss revenue GL accounts (31808, 34001 in format 3): '
        'each mart rebuild adds the AR shortfall per parent account to mart.job_month.revenue. Set `until` to the first '
        'month the export includes them; from null = off.')
ON CONFLICT (key) DO NOTHING;
