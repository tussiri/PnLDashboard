-- 075: the job title beside each HrDashboard employee name (app/sources/hrdashboard.py).
--
-- HrDashboard now sends the WinTeam pay info title with the number and name. Null when HR has none, or
-- sends none yet. Read by the labor hours report, like the name.

ALTER TABLE core.hr_employee_name ADD COLUMN IF NOT EXISTS title text;
