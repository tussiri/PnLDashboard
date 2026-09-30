-- 042: per-user permission overrides (Admin > Users > Permissions). A JSON object of
-- {"<permission key>": true|false} applied over the role's defaults (app/permissions.py); NULL or {}
-- = the role's defaults. Administrators keep every permission whatever this holds.

ALTER TABLE ops.app_user ADD COLUMN IF NOT EXISTS permissions jsonb;
