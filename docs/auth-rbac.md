# Sign-in and roles

The API decides who may see what; the browser only mirrors that decision in its navigation.
Everything lives in `services/api/app/auth.py` (users, hashes, session cookies, CLI),
`services/api/app/routers/auth.py` (routes) and `services/api/app/common.py` (dependencies).
No new Python dependencies: PBKDF2 and HMAC come from the standard library.

## Roles

| Role        | Sees                                   | API                                                                                   |
|-------------|----------------------------------------|---------------------------------------------------------------------------------------|
| `executive` | Executive Overview only                | `/executive/*`, `/system/status`, `/dimensions`                                       |
| `analyst`   | every view except Administration       | everything above plus reporting, labor, forecast and platform GET routes              |
| `admin`     | everything                             | everything, and platform/forecast POST/PUT routes without needing an admin token      |

Enforcement is attached to the `include_router` calls in `services/api/app/main.py`, so the router
modules stay free of session logic:

- `/health/*` and `/auth/*` are public.
- `platform_access`: `/system/status` and `/dimensions` for any signed-in role (the shell needs them);
  other platform GET routes need analyst or admin.
- `require_role("analyst", "admin")` on reporting, labor and forecast; `require_role("executive",
  "analyst", "admin")` on executive.
- Mutating requests (POST/PUT/PATCH/DELETE) accept **either** a valid `X-Admin-Token` **or** an
  admin-role session. `require_admin` on the individual write routes applies the same rule, so
  scripted calls with only the token keep working and a signed-in administrator does not need one.

Responses: `401` when no valid session exists, `403` when the role is not allowed.

## Users and passwords

Users come from `APP_USERS_JSON`, a JSON list:

```json
[
  {"username": "jane", "role": "admin",     "password_hash": "pbkdf2_sha256$600000$<salt_b64>$<hash_b64>"},
  {"username": "omar", "role": "analyst",   "password_hash": "pbkdf2_sha256$600000$..."},
  {"username": "cfo",  "role": "executive", "password_hash": "pbkdf2_sha256$600000$..."}
]
```

Generate a hash (PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte random salt):

```sh
docker compose run --rm api python -m app.auth hash 'the password'
# or, from services/api with Python 3.12: python -m app.auth hash 'the password'
```

List the configured usernames and roles (hashes are never printed):

```sh
docker compose run --rm api python -m app.auth users
```

Usernames are case-sensitive and must be unique; roles must be one of the three above; a malformed
hash is a configuration error. Password checks use `hmac.compare_digest`; an unknown username still
pays for one hash comparison, and every failed login sleeps about 300 ms.

## Sessions

`POST /api/v1/auth/login` with `{"username", "password"}` returns `{"user": {"username", "role"}}` and
sets the `crane_session` cookie: HttpOnly, SameSite=Lax, `Secure` when the request arrived over HTTPS
(directly or via `X-Forwarded-Proto: https`), max-age 12 hours. The value is
`base64url(username|role|expiry).hex(HMAC-SHA256(APP_SESSION_SECRET, payload))`; the API re-verifies
the signature and expiry on every request and never stores sessions server-side. Rotating
`APP_SESSION_SECRET` signs everyone out.

`GET /api/v1/auth/me` returns the current user or `401`; `POST /api/v1/auth/logout` clears the cookie;
`GET /api/v1/auth/mode` returns `{"mode": "dev" | "required"}` so the login page can show the
development notice.

The browser keeps nothing but the HttpOnly cookie. When any data route answers `401` the shell
returns to the login page.

## Modes

| `APP_AUTH_MODE` | Behaviour                                                                                                  |
|-----------------|------------------------------------------------------------------------------------------------------------|
| `dev`           | Adds the fixed development users below and falls back to a fixed development session secret. Compose default for the local stack. |
| `required`      | Only `APP_USERS_JSON` users; the API refuses to start unless `APP_USERS_JSON` has at least one user and `APP_SESSION_SECRET` is at least 32 characters. |
| unset           | `required` when `APP_SESSION_SECRET` or `APP_USERS_JSON` is present, otherwise `dev` (a warning is logged). |

Development users (dev mode only; configured users with the same username take precedence):

| Username    | Password        | Role      |
|-------------|-----------------|-----------|
| `executive` | `dev-executive` | executive |
| `analyst`   | `dev-analyst`   | analyst   |
| `admin`     | `dev-admin`     | admin     |

The login page shows a "Development sign-in" notice with these accounts when the API reports dev
mode. When no API is reachable at all, the front end offers a browser-only "Demo sign-in" that
accepts the same three accounts and opens the labeled demo dataset; nothing is sent anywhere.

## Production variables

Add to `.env` (see `.env.example`):

```sh
APP_AUTH_MODE=required
APP_SESSION_SECRET=<openssl rand -hex 32>
APP_USERS_JSON='[{"username":"jane","role":"admin","password_hash":"pbkdf2_sha256$600000$..."}]'
```

Keep `APP_USERS_JSON` single-quoted in `.env`: the hashes contain `$`, which Compose would otherwise
try to interpolate. `compose.yaml` passes all three variables to the `api`, `worker` and `migrate`
services through `x-api-environment`; only the API reads them. Restart the API after changing users:
`docker compose up -d api`.

## Tests

`services/api/tests/test_auth.py` covers hashing and verification, malformed hashes, session
signing/verification/expiry/tampering, dev-mode users, required-mode start-up refusals, cookie flags,
the read matrix per role (401/403/200) and the write routes (token or admin session). Front end:
`src/auth/roles.test.ts` (role to visible routes, demo sign-in) and `src/copy.test.ts` (no symbol
glyphs or placeholder brand in UI source).
