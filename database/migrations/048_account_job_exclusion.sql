-- 048: jobs held out of every account (shown as Other). Auto-assignment (app/accounts.py) maps a new
-- job by its parent job or WinTeam parent-account label; a job listed here is never auto-mapped again.
-- Written when an administrator unmaps a job and from a seed account's exclude_jobs (e.g. Amazon's
-- project, management and closed jobs that the weekly Amazon report leaves out); mapping the job to an
-- account in Admin removes it.

CREATE TABLE IF NOT EXISTS ops.account_job_exclusion (
  company text NOT NULL,
  job_number text NOT NULL,
  excluded_by text NOT NULL CHECK (excluded_by IN ('seed', 'admin')),
  excluded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, job_number)
);
