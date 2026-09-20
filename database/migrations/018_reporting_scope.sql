-- 018: Sub-accounts on the monthly reporting mart (docs/reporting-scope.md).
--
-- The reporting endpoints gained the key-account scope (scope=key|all|other, account,
-- sub_account, delivery - docs/api-contract.md "Reporting scope: key accounts first"). The
-- sub-account drill-down needs the same second-level label mart.job_week already carries
-- (migration 014) on the monthly mart, so MartFilters.clause can filter mart.job_month by it.
--
-- Derived by app.weekly.apply_sub_accounts from the setting sub_account_rules at the end of every
-- mart rebuild - one Python pass over core.dim_job, written back to both marts - so the two tables
-- always carry identical labels. Jobs without a parent account keep sub_account NULL.
ALTER TABLE mart.job_month ADD COLUMN IF NOT EXISTS sub_account text;
CREATE INDEX IF NOT EXISTS job_month_sub_account_idx ON mart.job_month (parent_account, sub_account, month);
