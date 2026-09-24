-- 033: parent-billed revenue is spread by account configuration at read time, not by WinTeam
-- parent-job links. Crowley ISD bills the district on job 910 but its schools carry no WinTeam parent
-- job, and it has no budget hours; White Settlement bills on job 112. routers/leadership.py now takes
-- an account's billing catch-all jobs (role catch_all with revenue) and spreads their revenue over the
-- account's sites by revenue-month budget hours, else revenue-month actual hours. The mart keeps the
-- weights instead of a precomputed split, so a mapping change applies without a rebuild.
ALTER TABLE mart.leadership_week
  DROP COLUMN IF EXISTS revenue_alloc_in,
  DROP COLUMN IF EXISTS revenue_alloc_out,
  ADD COLUMN IF NOT EXISTS revenue_month_budget_hours numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_month_hours numeric(12, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN mart.leadership_week.revenue_month_budget_hours IS 'Budget hours of the job in the revenue month: the weight for spreading parent-billed revenue.';
COMMENT ON COLUMN mart.leadership_week.revenue_month_hours IS 'Actual hours of the job in the revenue month: the weight when the account has no budget hours.';
COMMENT ON COLUMN ops.account.revenue_allocation IS 'budget_hours: revenue on the account''s catch-all jobs is spread over its sites by revenue-month budget hours (actual hours when the account has none), when no site carries revenue of its own.';
