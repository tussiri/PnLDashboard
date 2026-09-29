"""Password hashing, session cookies, auth settings and the role dependency matrix."""
from __future__ import annotations

import time

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app import auth as auth_module
from app.auth import (
    COOKIE_NAME,
    SESSION_TTL_SECONDS,
    AuthSettings,
    User,
    dev_users,
    hash_password,
    parse_users_json,
    reset_auth_settings,
    sign_session,
    verify_password,
    verify_session,
)
from app.common import platform_access, require_admin, require_role
from app.config import ConfigurationError
from app.routers import auth as auth_router

SECRET = "unit-test-session-secret-that-is-long-enough-0123456789"


@pytest.fixture(autouse=True)
def _dev_settings():
    reset_auth_settings(AuthSettings.load({"APP_AUTH_MODE": "dev", "APP_SESSION_SECRET": SECRET}))
    yield
    reset_auth_settings(None)


# ── hashing ──────────────────────────────────────────────────────────────────
def test_hash_and_verify_roundtrip() -> None:
    encoded = hash_password("correct horse", iterations=1000)
    scheme, iterations, salt, digest = encoded.split("$")
    assert (scheme, iterations) == ("pbkdf2_sha256", "1000")
    assert salt and digest
    assert verify_password("correct horse", encoded)
    assert not verify_password("wrong", encoded)
    assert not verify_password("", encoded)
    assert hash_password("same", iterations=1000) != hash_password("same", iterations=1000)  # fresh salt


def test_malformed_hashes_never_verify() -> None:
    for bad in ("", "plaintext", "pbkdf2_sha256$x$y$z", "md5$1$abc$def", "pbkdf2_sha256$0$YWJj$YWJj", "pbkdf2_sha256$1$not-b64!$YWJj"):
        assert not verify_password("anything", bad)


def test_parse_users_json_validates() -> None:
    good = hash_password("pw", iterations=1000)
    users = parse_users_json(f'[{{"username":"jane","role":"Admin","password_hash":"{good}"}}]')
    assert users["jane"].role == "admin"
    assert parse_users_json("") == {}
    for raw, message in (
        ("not json", "not valid JSON"),
        ('{"username":"x"}', "JSON list"),
        (f'[{{"username":"","role":"admin","password_hash":"{good}"}}]', "missing a username"),
        (f'[{{"username":"a","role":"ceo","password_hash":"{good}"}}]', "role must be one of"),
        ('[{"username":"a","role":"admin","password_hash":"plain"}]', "password_hash must be"),
        (f'[{{"username":"a","role":"admin","password_hash":"{good}"}},{{"username":"a","role":"analyst","password_hash":"{good}"}}]', "more than once"),
    ):
        with pytest.raises(ConfigurationError, match=message):
            parse_users_json(raw)


# ── sessions ─────────────────────────────────────────────────────────────────
def test_session_sign_verify_and_expiry() -> None:
    now = 1_800_000_000.0
    token = sign_session(User("jane", "analyst"), SECRET, now=now)
    assert verify_session(token, SECRET, now=now + 10) == User("jane", "analyst")
    assert verify_session(token, SECRET, now=now + SESSION_TTL_SECONDS - 1) is not None
    assert verify_session(token, SECRET, now=now + SESSION_TTL_SECONDS) is None
    assert verify_session(token, "another-secret-that-is-also-long-enough-000000", now=now) is None
    payload, signature = token.split(".")
    assert verify_session(f"{payload}x.{signature}", SECRET, now=now) is None  # tampered payload
    assert verify_session(f"{payload}.{signature[:-1]}0", SECRET, now=now) is None  # tampered signature
    for bad in (None, "", "nodot", "a.b", ".."):
        assert verify_session(bad, SECRET, now=now) is None


def test_session_rejects_unknown_role_even_when_signed() -> None:
    token = sign_session(User("jane", "analyst"), SECRET, now=1_800_000_000.0)
    forged_payload = auth_module._b64url(b"jane|superuser|1900000000")
    forged = f"{forged_payload}.{auth_module._signature(b'jane|superuser|1900000000', SECRET)}"
    assert verify_session(forged, SECRET, now=1_800_000_000.0) is None
    assert verify_session(token, SECRET, now=1_800_000_000.0) is not None


# ── settings ─────────────────────────────────────────────────────────────────
def test_dev_mode_users_and_authentication() -> None:
    settings = AuthSettings.load({"APP_AUTH_MODE": "dev"})
    assert settings.dev_mode and settings.session_secret
    assert set(dev_users()) == {"executive", "analyst", "admin"}
    for name in ("executive", "analyst", "admin"):
        assert settings.authenticate(name, f"dev-{name}") == User(name, name)
        assert settings.authenticate(name, "dev-wrong") is None
    assert settings.authenticate("nobody", "dev-nobody") is None
    assert settings.authenticate("", "") is None
    assert all("password_hash" not in entry for entry in settings.listing())


def test_dev_mode_configured_users_override_dev_users() -> None:
    good = hash_password("s3cret", iterations=1000)
    settings = AuthSettings.load({"APP_AUTH_MODE": "dev", "APP_USERS_JSON": f'[{{"username":"admin","role":"admin","password_hash":"{good}"}},{{"username":"jane","role":"executive","password_hash":"{good}"}}]'})
    assert settings.authenticate("admin", "dev-admin") is None
    assert settings.authenticate("admin", "s3cret") == User("admin", "admin")
    assert settings.authenticate("jane", "s3cret") == User("jane", "executive")
    assert settings.authenticate("executive", "dev-executive") == User("executive", "executive")


def test_required_mode_refuses_incomplete_configuration() -> None:
    good = hash_password("pw", iterations=1000)
    users = f'[{{"username":"jane","role":"admin","password_hash":"{good}"}}]'
    # Users can come from the database, so a secret alone is enough to start.
    assert AuthSettings.load({"APP_AUTH_MODE": "required", "APP_SESSION_SECRET": SECRET}).users == {}
    with pytest.raises(ConfigurationError, match="APP_SETUP_TOKEN"):
        AuthSettings.load({"APP_AUTH_MODE": "required", "APP_SESSION_SECRET": SECRET, "APP_SETUP_TOKEN": "short"})
    with pytest.raises(ConfigurationError, match="APP_SESSION_SECRET"):
        AuthSettings.load({"APP_AUTH_MODE": "required", "APP_USERS_JSON": users})
    with pytest.raises(ConfigurationError, match="APP_SESSION_SECRET"):
        AuthSettings.load({"APP_AUTH_MODE": "required", "APP_USERS_JSON": users, "APP_SESSION_SECRET": "short"})
    with pytest.raises(ConfigurationError, match="APP_AUTH_MODE"):
        AuthSettings.load({"APP_AUTH_MODE": "open"})
    settings = AuthSettings.load({"APP_AUTH_MODE": "required", "APP_USERS_JSON": users, "APP_SESSION_SECRET": SECRET})
    assert not settings.dev_mode
    assert settings.authenticate("admin", "dev-admin") is None  # no development users in required mode
    assert settings.authenticate("jane", "pw") == User("jane", "admin")


def test_unset_mode_defaults() -> None:
    assert AuthSettings.load({}).mode == "dev"
    assert AuthSettings.load({"APP_SESSION_SECRET": SECRET}).mode == "required"  # presence of production variables implies required


# ── role dependency matrix ───────────────────────────────────────────────────
def build_app(admin_token: str = "tok") -> TestClient:
    from app.config import settings as app_settings

    object.__setattr__(app_settings, "ingestion_admin_token", admin_token)
    app = FastAPI()
    app.include_router(auth_router.router, prefix="/api/v1")

    def exec_route():
        return {"ok": True}

    app.add_api_route("/api/v1/executive/labor-pl", exec_route, methods=["GET"], dependencies=[Depends(require_role("executive", "analyst", "admin"))])
    app.add_api_route("/api/v1/portfolio/summary", exec_route, methods=["GET"], dependencies=[Depends(require_role("analyst", "admin"))])
    app.add_api_route("/api/v1/forecasts/rebuild", exec_route, methods=["POST"], dependencies=[Depends(require_role("analyst", "admin")), Depends(require_admin)])
    app.add_api_route("/api/v1/system/status", exec_route, methods=["GET"], dependencies=[Depends(platform_access)])
    app.add_api_route("/api/v1/dimensions", exec_route, methods=["GET"], dependencies=[Depends(platform_access)])
    app.add_api_route("/api/v1/settings", exec_route, methods=["GET"], dependencies=[Depends(platform_access)])
    app.add_api_route("/api/v1/settings/close_lag_days", exec_route, methods=["PUT"], dependencies=[Depends(platform_access), Depends(require_admin)])
    app.add_api_route("/api/v1/marts/rebuild", exec_route, methods=["POST"], dependencies=[Depends(platform_access), Depends(require_admin)])
    return TestClient(app)


def login(client: TestClient, role: str) -> None:
    client.cookies.clear()
    response = client.post("/api/v1/auth/login", json={"username": role, "password": f"dev-{role}"})
    assert response.status_code == 200, response.text
    assert response.json() == {"user": {"username": role, "role": role}}
    assert COOKIE_NAME in response.cookies


def test_login_logout_me_and_cookie_flags() -> None:
    client = build_app()
    assert client.get("/api/v1/auth/mode").json() == {"mode": "dev"}
    assert client.get("/api/v1/auth/me").status_code == 401
    started = time.perf_counter()
    bad = client.post("/api/v1/auth/login", json={"username": "admin", "password": "nope"})
    assert bad.status_code == 401 and time.perf_counter() - started >= 0.25
    assert COOKIE_NAME not in bad.cookies
    login(client, "analyst")
    set_cookie = client.post("/api/v1/auth/login", json={"username": "analyst", "password": "dev-analyst"}).headers["set-cookie"].lower()
    assert "httponly" in set_cookie and "samesite=lax" in set_cookie and "secure" not in set_cookie and f"max-age={SESSION_TTL_SECONDS}" in set_cookie
    assert client.get("/api/v1/auth/me").json() == {"user": {"username": "analyst", "role": "analyst", "accounts": None}}
    assert client.post("/api/v1/auth/logout").json() == {"ok": True}
    client.cookies.clear()
    assert client.get("/api/v1/auth/me").status_code == 401


def test_secure_flag_follows_forwarded_proto() -> None:
    client = build_app()
    https = client.post("/api/v1/auth/login", json={"username": "admin", "password": "dev-admin"}, headers={"x-forwarded-proto": "https"})
    assert "secure" in https.headers["set-cookie"].lower()


@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (None, {"executive/labor-pl": 401, "portfolio/summary": 401, "system/status": 401, "dimensions": 401, "settings": 401}),
        ("executive", {"executive/labor-pl": 200, "portfolio/summary": 403, "system/status": 200, "dimensions": 200, "settings": 403}),
        ("analyst", {"executive/labor-pl": 200, "portfolio/summary": 200, "system/status": 200, "dimensions": 200, "settings": 200}),
        ("admin", {"executive/labor-pl": 200, "portfolio/summary": 200, "system/status": 200, "dimensions": 200, "settings": 200}),
    ],
)
def test_read_matrix(role: str | None, expected: dict[str, int]) -> None:
    client = build_app()
    if role:
        login(client, role)
    for path, status in expected.items():
        assert client.get(f"/api/v1/{path}").status_code == status, (role, path)


def test_write_routes_accept_admin_token_or_admin_session() -> None:
    client = build_app()
    for path in ("/api/v1/marts/rebuild", "/api/v1/forecasts/rebuild"):
        assert client.post(path).status_code == 401
        assert client.post(path, headers={"X-Admin-Token": "wrong"}).status_code == 401
        assert client.post(path, headers={"X-Admin-Token": "tok"}).status_code == 200  # token alone, no session
    assert client.put("/api/v1/settings/close_lag_days", headers={"X-Admin-Token": "tok"}).status_code == 200
    login(client, "analyst")
    assert client.post("/api/v1/marts/rebuild").status_code == 403
    assert client.post("/api/v1/marts/rebuild", headers={"X-Admin-Token": "tok"}).status_code == 200
    login(client, "executive")
    assert client.put("/api/v1/settings/close_lag_days").status_code == 403
    login(client, "admin")
    assert client.post("/api/v1/marts/rebuild").status_code == 200  # session alone, no token
    assert client.put("/api/v1/settings/close_lag_days").status_code == 200


def test_expired_or_tampered_cookie_is_signed_out() -> None:
    client = build_app()
    expired = sign_session(User("admin", "admin"), SECRET, now=time.time() - SESSION_TTL_SECONDS - 5)
    client.cookies.set(COOKIE_NAME, expired)
    assert client.get("/api/v1/auth/me").status_code == 401
    client.cookies.set(COOKIE_NAME, sign_session(User("admin", "admin"), "some-other-secret-that-is-long-enough-000000"))
    assert client.get("/api/v1/portfolio/summary").status_code == 401


def test_cli_hash_and_users(capsys: pytest.CaptureFixture[str]) -> None:
    assert auth_module.main(["hash", "pw"]) == 0
    printed = capsys.readouterr().out.strip()
    assert printed.startswith("pbkdf2_sha256$") and verify_password("pw", printed)
    assert auth_module.main(["users"]) == 0
    out = capsys.readouterr().out
    assert "mode: dev" in out and "executive\texecutive\tdev" in out and "pbkdf2" not in out
    assert auth_module.main([]) == 2
    assert auth_module.main(["hash"]) == 2
