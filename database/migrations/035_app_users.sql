-- 035: sign-in users managed in Admin > Users (app/users.py, docs/auth-rbac.md).
--
-- Accounts created in the dashboard live here; APP_USERS_JSON stays as an environment-defined
-- fallback. The first administrator is created through the one-time setup page, which needs
-- APP_SETUP_TOKEN and closes once any user exists. Passwords are stored as PBKDF2 hashes only.
-- Sessions issued before sessions_valid_after (a password reset) are refused.

CREATE TABLE IF NOT EXISTS ops.app_user (
  username text PRIMARY KEY CHECK (username ~ '^[A-Za-z0-9._@-]{2,100}$'),
  role text NOT NULL CHECK (role IN ('executive', 'analyst', 'admin')),
  password_hash text NOT NULL CHECK (password_hash LIKE 'pbkdf2_sha256$%'),
  active boolean NOT NULL DEFAULT true,
  sessions_valid_after timestamptz NOT NULL DEFAULT date_trunc('second', now()),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  last_login_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS app_user_username_lower_idx ON ops.app_user (lower(username));
