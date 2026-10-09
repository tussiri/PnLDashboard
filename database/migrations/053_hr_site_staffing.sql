-- 053: HrDashboard site staffing by week (app/sources/hrdashboard.py).
--
-- HrDashboard serves GET /api/service/v1/pnl/site-staffing (bearer token): one row per site per
-- Monday-start week, site-level counts only, never a person. The site key is the WinTeam job number
-- together with the WinTeam database ('Crane' | 'Sarus'), mapped from HR's tenant on the way in.
-- job_key is resolved the same way as core.fact_staffing_request (app/staffing.py): NULL when the
-- job is unknown here, and re-resolved on every pull. No foreign key, so a reference reload can
-- re-key core.dim_job.
--
-- Hires and separations happened in the week, so every pull overwrites them. Positions, filled
-- positions, open positions and active headcount are how the site stood when HR answered, sent on
-- the current week only: a pull never replaces a value already held with a NULL, so each week keeps
-- what was last seen during it and the history builds forward from the first pull.

CREATE TABLE IF NOT EXISTS core.hr_site_staffing_week (
  winteam_company text NOT NULL,
  winteam_job_number text NOT NULL,
  week_start date NOT NULL,
  job_key bigint,
  hires integer,
  separations integer,
  budgeted_positions numeric(7, 1),
  positions_source text,       -- tracker | budget | observed
  filled_positions integer,
  open_positions integer,
  active_headcount integer,
  headcount_source text,       -- employee_master | timekeeping
  hr_as_of date,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (winteam_company, winteam_job_number, week_start)
);
CREATE INDEX IF NOT EXISTS hr_site_staffing_week_job_idx ON core.hr_site_staffing_week (job_key, week_start);

COMMENT ON TABLE core.hr_site_staffing_week IS
  'HrDashboard site staffing per Monday-start week (app/sources/hrdashboard.py). Site-level counts only.';
