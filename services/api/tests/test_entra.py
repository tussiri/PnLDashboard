"""Microsoft sign-in (app/entra.py, /auth/entra/start, /auth/callback/entra) and AUTH_PASSWORD_LOGIN."""
from __future__ import annotations

import base64
import json
import time
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app import entra, users
from app.auth import AuthSettings, ConfigurationError, reset_auth_settings
from app.routers import auth as auth_router
from tests.test_users import PASSWORD, SECRET, SETUP, client, signin, store  # noqa: F401 - store is a fixture

TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
ENTRA = {"ENTRA_TENANT_ID": TENANT, "ENTRA_CLIENT_ID": CLIENT_ID, "ENTRA_CLIENT_SECRET": "secret-value",
         "ENTRA_REDIRECT_URI": "https://pnl.example.com/api/v1/auth/callback/entra"}


def settings(**env):
    reset_auth_settings(AuthSettings.load({"APP_AUTH_MODE": "required", "APP_SESSION_SECRET": SECRET, "APP_SETUP_TOKEN": SETUP, **env}))


@pytest.fixture(autouse=True)
def _reset():
    yield
    reset_auth_settings(None)


def token(**claims) -> str:
    body = {"iss": f"https://login.microsoftonline.com/{TENANT}/v2.0", "aud": CLIENT_ID, "tid": TENANT,
            "exp": time.time() + 3600, "preferred_username": "Ana@Crane.com", **claims}
    part = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")
    return f"e30.{part}.sig"


def start(c: TestClient) -> dict[str, str]:
    """Begin a sign-in; returns the authorize URL's query parameters."""
    r = c.get("/api/v1/auth/entra/start", follow_redirects=False)
    assert r.status_code == 303
    url = urlparse(r.headers["location"])
    assert url.netloc == "login.microsoftonline.com" and url.path == f"/{TENANT}/oauth2/v2.0/authorize"
    return {k: v[0] for k, v in parse_qs(url.query).items()}


def returning(c: TestClient, monkeypatch, *, claims=None, state=None, **query):
    """Come back from Microsoft with an ID token carrying the start's nonce (plus `claims`)."""
    params = start(c)
    seen = {}

    def fake_exchange(config, code, verifier):
        seen.update(code=code, verifier=verifier)
        return token(**{"nonce": params["nonce"], **(claims or {})})
    monkeypatch.setattr(entra, "exchange_code", fake_exchange)
    q = {"code": "the-code", "state": params["state"] if state is None else state, **query}
    r = c.get("/api/v1/auth/callback/entra", params=q, follow_redirects=False)
    return r, params, seen


def with_users(c: TestClient):
    c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "boss", "password": PASSWORD})
    c.post("/api/v1/users", json={"username": "ana@crane.com", "role": "analyst", "password": PASSWORD})
    c.cookies.clear()


def test_microsoft_sign_in_for_a_dashboard_user(store, monkeypatch):
    settings(**ENTRA)
    c = client()
    with_users(c)
    assert c.get("/api/v1/auth/mode").json() == {"mode": "required", "microsoft": True, "password": "all"}
    r, params, seen = returning(c, monkeypatch)
    assert params["code_challenge_method"] == "S256" and params["scope"] == "openid profile email"
    assert params["redirect_uri"] == ENTRA["ENTRA_REDIRECT_URI"] and params["client_id"] == CLIENT_ID
    assert seen["code"] == "the-code" and len(seen["verifier"]) >= 43
    assert r.status_code == 303 and r.headers["location"] == "/"
    me = c.get("/api/v1/auth/me").json()["user"]
    assert me["username"] == "ana@crane.com" and me["role"] == "analyst"  # email matched regardless of case


@pytest.mark.parametrize("claims,error", [
    ({"aud": "another-app"}, "failed"),
    ({"tid": "99999999-2222-3333-4444-555555555555"}, "failed"),
    ({"iss": "https://login.microsoftonline.com/common/v2.0"}, "failed"),
    ({"nonce": "replayed"}, "failed"),
    ({"exp": time.time() - 3600}, "expired"),
])
def test_microsoft_sign_in_refusals(store, monkeypatch, claims, error):
    settings(**ENTRA)
    c = client()
    with_users(c)
    r, _, _ = returning(c, monkeypatch, claims=claims)
    assert r.headers["location"] == f"/?signin_error={error}"
    assert c.get("/api/v1/auth/me").status_code == 401


def test_a_first_microsoft_sign_in_lands_with_no_access(store, monkeypatch):
    settings(**ENTRA)
    c = client()
    with_users(c)
    r, _, _ = returning(c, monkeypatch, claims={"preferred_username": "New.Person@Crane.com"})
    assert r.headers["location"] == "/"
    me = c.get("/api/v1/auth/me").json()["user"]
    assert me["username"] == "new.person@crane.com" and me["role"] == "none" and me["role_name"] == "No access"
    assert not any(me["permissions"].values())
    assert c.get("/api/v1/view").status_code == 403  # nothing opens until an administrator picks a role
    assert store.get("new.person@crane.com").created_by == "microsoft"
    boss = client()
    signin(boss, "boss")
    assert boss.patch("/api/v1/users/new.person@crane.com", json={"role": "analyst"}).status_code == 200
    users.clear_cache()
    assert c.get("/api/v1/view").status_code == 200
    r, _, _ = returning(c, monkeypatch, claims={"preferred_username": "odd+tag@crane.com"})
    assert r.headers["location"] == "/?signin_error=not_provisioned"  # an email that cannot be a username


def test_callback_needs_the_flow_cookie_and_its_state(store, monkeypatch):
    settings(**ENTRA)
    c = client()
    with_users(c)
    r, _, _ = returning(c, monkeypatch, state="forged")
    assert r.headers["location"] == "/?signin_error=failed"
    fresh = client()
    r = fresh.get("/api/v1/auth/callback/entra", params={"code": "x", "state": "y"}, follow_redirects=False)
    assert r.headers["location"] == "/?signin_error=expired"  # no cookie: started elsewhere or too long ago
    r, _, _ = returning(c, monkeypatch, error="access_denied")
    assert r.headers["location"] == "/?signin_error=cancelled"


def test_a_disabled_user_cannot_sign_in_with_microsoft(store, monkeypatch):
    settings(**ENTRA)
    c = client()
    with_users(c)
    signin(c, "boss")
    c.patch("/api/v1/users/ana@crane.com", json={"active": False})
    users.clear_cache()
    c.cookies.clear()
    r, _, _ = returning(c, monkeypatch)
    assert r.headers["location"] == "/?signin_error=not_provisioned"


def test_password_login_for_admins_only(store, monkeypatch):
    settings(AUTH_PASSWORD_LOGIN="admins", **ENTRA)
    c = client()
    with_users(c)
    assert c.get("/api/v1/auth/mode").json()["password"] == "admins"
    assert signin(c, "boss") == 200  # the administrator keeps a password
    assert signin(c, "ana@crane.com") == 403  # everyone else uses Microsoft
    r, _, _ = returning(c, monkeypatch)
    assert r.headers["location"] == "/"


def test_environment_users_keep_their_password(store):
    from app.auth import hash_password

    env = f'[{{"username":"viewer","role":"executive","password_hash":"{hash_password("env-password-123", iterations=1000)}"}}]'
    settings(AUTH_PASSWORD_LOGIN="admins", APP_USERS_JSON=env, **ENTRA)
    assert signin(client(), "viewer", "env-password-123") == 200


def test_microsoft_off_by_default(store):
    settings()
    c = client()
    assert c.get("/api/v1/auth/mode").json() == {"mode": "required", "microsoft": False, "password": "all"}
    r = c.get("/api/v1/auth/entra/start", follow_redirects=False)
    assert r.headers["location"] == "/?signin_error=off"


def test_entra_configuration_is_all_or_nothing():
    with pytest.raises(ConfigurationError, match="missing ENTRA_CLIENT_SECRET"):
        settings(**{**ENTRA, "ENTRA_CLIENT_SECRET": ""})
    with pytest.raises(ConfigurationError, match="GUID"):
        settings(**{**ENTRA, "ENTRA_TENANT_ID": "crane.com"})
    with pytest.raises(ConfigurationError, match="https"):
        settings(**{**ENTRA, "ENTRA_REDIRECT_URI": "http://pnl.example.com/cb"})
    with pytest.raises(ConfigurationError, match="needs Microsoft sign-in"):
        settings(AUTH_PASSWORD_LOGIN="admins")
    with pytest.raises(ConfigurationError, match="AUTH_PASSWORD_LOGIN"):
        settings(AUTH_PASSWORD_LOGIN="nobody", **ENTRA)


def test_flow_cookie_is_signed_for_its_purpose():
    from app.auth import sign_value, verify_value

    signed = sign_value(b"payload", SECRET, auth_router.FLOW_PURPOSE)
    assert verify_value(signed, SECRET, auth_router.FLOW_PURPOSE) == b"payload"
    assert verify_value(signed, SECRET, "session") is None
    assert verify_value(signed[:-1] + ("0" if signed[-1] != "0" else "1"), SECRET, auth_router.FLOW_PURPOSE) is None
