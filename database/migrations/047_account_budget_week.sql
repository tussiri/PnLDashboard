-- 047: the weekly side of an account's labor plan (Admin > Budgets): the budget for each week from the
-- plan's day calendar (school, staff, closure, summer days and stat holidays fall in particular weeks,
-- so a month's plan cannot simply be split). Site and overhead labor per week, and the stat-holiday
-- pay that week (paid or not per the account view's toggle). Drives the weekly budget target.

CREATE TABLE IF NOT EXISTS ops.account_budget_week (
  account_slug text NOT NULL REFERENCES ops.account (slug) ON UPDATE CASCADE ON DELETE CASCADE,
  week_end date NOT NULL CHECK (extract(isodow FROM week_end) = 7),
  site_labor numeric(14, 2) NOT NULL DEFAULT 0,
  overhead_labor numeric(14, 2) NOT NULL DEFAULT 0,
  holiday_labor numeric(14, 2) NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (account_slug, week_end)
);
