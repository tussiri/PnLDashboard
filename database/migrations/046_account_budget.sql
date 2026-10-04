-- 046: an account's monthly labor plan (Admin > Budgets, pasted from the account's budget workbook), the
-- budget behind the account Budget tab. Site and overhead labor are the plan's own lines; revenue is
-- the planned billing; details keeps the calendar the plan was built on (school days, staff days,
-- closures, summer days, stat holidays) as given. Separate from WinTeam's job budgets.

CREATE TABLE IF NOT EXISTS ops.account_budget_month (
  account_slug text NOT NULL REFERENCES ops.account (slug) ON UPDATE CASCADE ON DELETE CASCADE,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  site_labor numeric(14, 2),
  overhead_labor numeric(14, 2),
  revenue numeric(14, 2),
  supplies numeric(14, 2),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (account_slug, month)
);
