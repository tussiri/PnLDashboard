-- 073: weekly labor from WinTeam rates for every week (app/leadership.py, setting weekly_labor_source).
--
-- The emailed paid-timekeeping pay reports (62_*.csv) price Plano's September and October weeks at $19-22 an hour
-- against $17-18 from the WinTeam punches at the same hours, and leave weeks short of hours (Oct 12-18). The CDO's
-- dashboards use timekeeping priced at WinTeam rates. 'pay_report' restores the pay report for covered weeks.
INSERT INTO ops.app_setting (key, value, description)
VALUES ('weekly_labor_source', '"winteam_rates"'::jsonb,
        'winteam_rates: every week''s labor from the WinTeam punches at their pay rates; pay_report: a week (and a month) a pay report covers takes the pay report''s dollars.')
ON CONFLICT (key) DO NOTHING;
