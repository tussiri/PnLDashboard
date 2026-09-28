-- 028: account configuration for the leadership labor P&L.
--
-- A featured account is a row in ops.account; which jobs belong to it, their segment and their role
-- (billed site, catch-all with no billing of its own, or non-billed work) are explicit rows in
-- ops.account_job, maintained from the Administration page. Jobs without a row roll into "Other".
-- Seed data lives in config/accounts/seed.json (app/accounts.py), not here, so a fresh database and
-- this one are configured the same way.

CREATE TABLE IF NOT EXISTS ops.account (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  featured boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 100,
  target_labor_pct numeric(6,4) NOT NULL DEFAULT 0.645 CHECK (target_labor_pct > 0 AND target_labor_pct < 2),
  watch_band numeric(6,4) NOT NULL DEFAULT 0.10 CHECK (watch_band >= 0 AND watch_band < 1),
  revenue_method text NOT NULL DEFAULT 'monthly_div' CHECK (revenue_method IN ('monthly_div', 'weekly_billing', 'per_visit')),
  revenue_divisor numeric(6,3) NOT NULL DEFAULT 4.33 CHECK (revenue_divisor > 0),
  budget_reliability_ratio numeric(6,4) NOT NULL DEFAULT 0.80,
  source_parent_accounts text[] NOT NULL DEFAULT '{}',
  segment_source text NOT NULL DEFAULT 'explicit' CHECK (segment_source IN ('explicit', 'sub_account', 'company', 'fallback')),
  fallback_segment text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

COMMENT ON TABLE ops.account IS
  'Featured accounts of the leadership P&L. target_labor_pct and watch_band are fractions; revenue_method monthly_div = prior closed month revenue / revenue_divisor per week. source_parent_accounts: current parent-account labels whose new jobs are auto-assigned (flagged for review).';

CREATE TABLE IF NOT EXISTS ops.account_segment (
  account_slug text NOT NULL REFERENCES ops.account (slug) ON UPDATE CASCADE ON DELETE CASCADE,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 100,
  target_labor_pct numeric(6,4) CHECK (target_labor_pct IS NULL OR (target_labor_pct > 0 AND target_labor_pct < 2)),
  PRIMARY KEY (account_slug, name)
);

COMMENT ON COLUMN ops.account_segment.target_labor_pct IS 'Overrides the account target for this segment (e.g. Crane West sites of Amazon); null = the account target.';

CREATE TABLE IF NOT EXISTS ops.account_job (
  company text NOT NULL,
  job_number text NOT NULL,
  account_slug text NOT NULL REFERENCES ops.account (slug) ON UPDATE CASCADE ON DELETE CASCADE,
  segment text,
  role text NOT NULL DEFAULT 'site' CHECK (role IN ('site', 'catch_all', 'non_billed')),
  companycam_project_id text,
  assigned_by text NOT NULL DEFAULT 'seed' CHECK (assigned_by IN ('seed', 'auto', 'admin')),
  needs_review boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (company, job_number)
);

CREATE INDEX IF NOT EXISTS account_job_account_idx ON ops.account_job (account_slug);

COMMENT ON TABLE ops.account_job IS
  'Job-to-account mapping (one account per company + job number). role: site = billed location; catch_all = labor not recorded at a site, counted in the account header with no billing; non_billed = work outside the header (special events). needs_review marks rows assigned automatically.';
