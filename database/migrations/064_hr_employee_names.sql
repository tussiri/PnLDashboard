-- 064: employee names from HrDashboard (GET /api/service/v1/pnl/employee-names, app/sources/hrdashboard.py).
--
-- The WinTeam timekeeping API has no names, so the labor hours report knows recent hires only by number.
-- Number and name only, replaced whole on each pull so someone HR no longer holds goes too. Read by the
-- labor hours report alone (permission report.labor-hours); nothing in mart or Metabase selects it.

CREATE TABLE IF NOT EXISTS core.hr_employee_name (
  winteam_company text NOT NULL,   -- 'Crane' | 'Sarus' (HR_TENANT_COMPANIES)
  employee_number text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (winteam_company, employee_number)
);
