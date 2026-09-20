-- 017: Keep the WinTeam API's own timekeeping rate for reference while pricing every API punch at the
-- job's trailing payroll rate (job-cost direct labor / hours), so live labor dollars stay on the same
-- all-in payroll basis as the closed-month P&L. Verified 2026-09-04: API `rate` (~$17.0/h base) runs ~8%
-- below the payroll all-in rate (~$18.7/h) the executives' figures are built on.
ALTER TABLE core.fact_timekeeping ADD COLUMN IF NOT EXISTS source_rate numeric(12, 4);
