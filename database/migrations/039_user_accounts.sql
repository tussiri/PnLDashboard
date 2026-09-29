-- 039: accounts a sign-in user may see (Admin > Users). NULL = every account. Administrators see
-- every account whatever this holds. Enforced by the API on the leadership routes; a user limited to
-- accounts cannot open the all-account views (Analytics, the retired reporting routes).

ALTER TABLE ops.app_user ADD COLUMN IF NOT EXISTS account_slugs text[];
