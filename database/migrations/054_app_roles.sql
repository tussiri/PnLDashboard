-- 054: roles defined in the dashboard (Admin > Users > Roles; app/roles.py, docs/auth-rbac.md).
--
-- A role is a named set of permissions (the keys in app/permissions.py). Executive and Analyst are
-- built in: a row here only records an administrator's edits to them, and a key missing from such a
-- row keeps the built-in default. Any other row is a custom role, where a missing key is off.
-- Administrator (every permission) and No access (none; the role of a first Microsoft sign-in) are
-- fixed in code and never stored. Users now name a role by its slug instead of one of three values.

CREATE TABLE IF NOT EXISTS ops.app_role (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$' AND slug NOT IN ('admin', 'none')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS app_role_name_lower_idx ON ops.app_role (lower(btrim(name)));

ALTER TABLE ops.app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
ALTER TABLE ops.app_user ADD CONSTRAINT app_user_role_check CHECK (role ~ '^[a-z0-9][a-z0-9-]{1,39}$');
