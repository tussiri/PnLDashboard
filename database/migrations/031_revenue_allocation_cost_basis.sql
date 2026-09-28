-- 031: parent-billed accounts and cost % (decisions of 2026-09-23).
--
-- revenue_allocation 'budget_hours': where a parent job carries the billing and its child jobs carry
-- none (White Settlement ISD bills the district on job 112), the parent's revenue-month revenue is
-- spread over the children by their budget hours in that month. mart.leadership_week records the
-- structural split (revenue_alloc_in on each child, revenue_alloc_out on the parent) for every such
-- family; routers/leadership.py applies it only for accounts that opt in.
--
-- cost_basis 'labor_plus_vendor': the account is measured by cost % = (labor + vendor cost) / invoice,
-- for accounts with subcontracted sites; 'labor' keeps the reference labor %.

ALTER TABLE ops.account
  ADD COLUMN IF NOT EXISTS revenue_allocation text NOT NULL DEFAULT 'none' CHECK (revenue_allocation IN ('none', 'budget_hours')),
  ADD COLUMN IF NOT EXISTS cost_basis text NOT NULL DEFAULT 'labor' CHECK (cost_basis IN ('labor', 'labor_plus_vendor'));

ALTER TABLE mart.leadership_week
  ADD COLUMN IF NOT EXISTS revenue_alloc_in numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_alloc_out numeric(14, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN mart.leadership_week.revenue_alloc_in IS 'Share of the parent job''s revenue-month revenue allocated to this child by budget hours (applied when the account''s revenue_allocation = budget_hours).';
COMMENT ON COLUMN mart.leadership_week.revenue_alloc_out IS 'Revenue-month revenue this parent job allocates to its children by budget hours.';
