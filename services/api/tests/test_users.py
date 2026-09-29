"""Database users (app/users.py) and the setup and /users routes, against an in-memory store."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.testclient import TestClient

from app import users
from app.auth import COOKIE_NAME, AuthSettings, User, hash_password, reset_auth_settings, sign_session
from app.common import require_role
from app.routers import auth as auth_router
from app.routers import users as users_router

SECRET = "unit-test-session-secret-that-is-long-enough-0123456789"
SETUP = "setup-code-that-is-long-enough-0123"
PASSWORD = "a-long-password"


class MemoryStore:
    def __init__(self):
        self.rows: dict[str, users.StoredUser] = {}

    def get(self, username):
        return self.rows.get(username.lower())

    def all(self):
        return sorted(self.rows.values(), key=lambda u: u.username.lower())

    def create(self, user, *, only_if_empty=False):
        if (only_if_empty and self.rows) or user.username.lower() in self.rows:
            return False
        self.rows[user.username.lower()] = replace(user, sessions_valid_after=datetime.now(timezone.utc).replace(microsecond=0))
        return True

    def update(self, username, changes, actor):
        current = self.rows.get(username.lower())
        if current is None:
            return None
        if "password_hash" in changes:
            changes = {**changes, "sessions_valid_after": datetime.now(timezone.utc).replace(microsecond=0) + timedelta(seconds=10)}
        self.rows[username.lower()] = replace(current, **changes)
        return self.rows[username.lower()]

    def touch_login(self, username):
        pass


@pytest.fixture()
def store():
    s = MemoryStore()
    users.set_store(s)
    yield s
    users.set_store(users.PostgresUserStore())


def settings(**env):
    reset_auth_settings(AuthSettings.load({"APP_AUTH_MODE": "required", "APP_SESSION_SECRET": SECRET, **env}))


@pytest.fixture(autouse=True)
def _reset():
    yield
    reset_auth_settings(None)


def client() -> TestClient:
    from app.config import settings as app_settings

    object.__setattr__(app_settings, "ingestion_admin_token", "tok")
    app = FastAPI()
    app.include_router(auth_router.router, prefix="/api/v1")
    app.include_router(users_router.router, prefix="/api/v1")
    app.add_api_route("/api/v1/view", lambda: {"ok": True}, methods=["GET"], dependencies=[Depends(require_role("executive", "analyst", "admin"))])
    return TestClient(app)


def signin(c: TestClient, username: str, password: str = PASSWORD) -> int:
    c.cookies.clear()
    return c.post("/api/v1/auth/login", json={"username": username, "password": password}).status_code


def test_setup_creates_the_first_admin_once(store):
    settings(APP_SETUP_TOKEN=SETUP)
    c = client()
    assert c.get("/api/v1/auth/setup").json() == {"needed": True}
    assert c.post("/api/v1/auth/setup", json={"token": "wrong", "username": "tumaini", "password": PASSWORD}).status_code == 401
    assert c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "tumaini", "password": "short"}).status_code == 422
    r = c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "tumaini", "password": PASSWORD})
    assert r.status_code == 201 and r.json() == {"user": {"username": "tumaini", "role": "admin"}}
    assert c.get("/api/v1/auth/me").json()["user"]["role"] == "admin"  # signed in by setup
    assert c.get("/api/v1/auth/setup").json() == {"needed": False}
    assert c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "other", "password": PASSWORD}).status_code == 409


def test_setup_is_closed_without_a_token_or_with_environment_users(store):
    settings()
    c = client()
    assert c.get("/api/v1/auth/setup").json() == {"needed": False}
    assert c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "x1", "password": PASSWORD}).status_code == 404
    env_user = f'[{{"username":"break","role":"admin","password_hash":"{hash_password(PASSWORD, iterations=1000)}"}}]'
    settings(APP_SETUP_TOKEN=SETUP, APP_USERS_JSON=env_user)
    assert client().get("/api/v1/auth/setup").json() == {"needed": False}


def test_admin_manages_users_and_roles_apply_to_live_sessions(store):
    settings(APP_SETUP_TOKEN=SETUP)
    c = client()
    c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "boss", "password": PASSWORD})
    assert c.post("/api/v1/users", json={"username": "ana", "role": "analyst", "password": PASSWORD}).status_code == 201
    assert c.post("/api/v1/users", json={"username": "ANA", "role": "analyst", "password": PASSWORD}).status_code == 409
    assert c.post("/api/v1/users", json={"username": "bad name", "role": "analyst", "password": PASSWORD}).status_code == 422
    assert c.post("/api/v1/users", json={"username": "x2", "role": "ceo", "password": PASSWORD}).status_code == 422
    listed = c.get("/api/v1/users").json()["users"]
    assert [(u["username"], u["role"], u["source"]) for u in listed] == [("ana", "analyst", "database"), ("boss", "admin", "database")]
    assert all("password_hash" not in u for u in listed)

    ana = client()
    assert signin(ana, "ana") == 200 and ana.get("/api/v1/view").status_code == 200
    assert ana.get("/api/v1/users").status_code == 401  # not an administrator
    c.patch("/api/v1/users/ana", json={"role": "executive"})
    users.clear_cache()
    assert ana.get("/api/v1/auth/me").json()["user"]["role"] == "executive"  # role read from the store
    c.patch("/api/v1/users/ana", json={"active": False})
    assert ana.get("/api/v1/view").status_code == 401  # disabled: existing session refused
    assert signin(ana, "ana") == 401


def test_password_reset_ends_earlier_sessions(store):
    settings(APP_SETUP_TOKEN=SETUP)
    c = client()
    c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "boss", "password": PASSWORD})
    c.post("/api/v1/users", json={"username": "ana", "role": "analyst", "password": PASSWORD})
    ana = client()
    signin(ana, "ana")
    assert c.patch("/api/v1/users/ana", json={"password": "another-long-password"}).status_code == 200
    assert ana.get("/api/v1/view").status_code == 401
    assert signin(ana, "ana") == 401 and signin(ana, "ana", "another-long-password") == 200


def test_the_last_active_admin_cannot_be_removed(store):
    settings(APP_SETUP_TOKEN=SETUP)
    c = client()
    c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "boss", "password": PASSWORD})
    assert c.patch("/api/v1/users/boss", json={"role": "analyst"}).status_code == 409
    assert c.patch("/api/v1/users/boss", json={"active": False}).status_code == 409
    c.post("/api/v1/users", json={"username": "second", "role": "admin", "password": PASSWORD})
    assert c.patch("/api/v1/users/boss", json={"role": "analyst"}).status_code == 200
    users.clear_cache()
    assert c.get("/api/v1/users").status_code == 401  # boss is an analyst now
    second = client()
    signin(second, "second")
    assert second.patch("/api/v1/users/nobody", json={"active": False}).status_code == 404
    assert second.patch("/api/v1/users/second", json={"active": False}).status_code == 409  # the only admin left


def test_environment_users_are_read_only_and_win_name_clashes(store):
    env_user = f'[{{"username":"break","role":"admin","password_hash":"{hash_password("env-password-123", iterations=1000)}"}}]'
    settings(APP_USERS_JSON=env_user)
    c = client()
    assert signin(c, "break", "env-password-123") == 200
    assert c.post("/api/v1/users", json={"username": "break", "role": "analyst", "password": PASSWORD}).status_code == 409
    assert c.patch("/api/v1/users/break", json={"active": False}).status_code == 409
    assert c.get("/api/v1/users").json()["users"][0]["source"] == "environment"


def test_a_cookie_for_an_unknown_user_is_refused(store):
    settings()
    c = client()
    c.cookies.set(COOKIE_NAME, sign_session(User("ghost", "admin"), SECRET))
    assert c.get("/api/v1/view").status_code == 401


def test_a_user_limited_to_an_account_sees_only_it(store, monkeypatch):
    from app.common import require_account
    from app.routers.leadership import scope_clause

    monkeypatch.setattr(users_router, "known_accounts", lambda: {"plano-isd", "fedex", "amazon"})
    settings(APP_SETUP_TOKEN=SETUP)
    c = client()
    c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "boss", "password": PASSWORD})
    assert c.post("/api/v1/users", json={"username": "pat", "role": "executive", "password": PASSWORD, "accounts": ["nowhere"]}).status_code == 422
    made = c.post("/api/v1/users", json={"username": "pat", "role": "executive", "password": PASSWORD, "accounts": ["plano-isd"]})
    assert made.status_code == 201 and made.json()["user"]["accounts"] == ["plano-isd"]

    app = c.app

    def fedex_route(request: Request):
        require_account(request, "fedex")
        return {"ok": True}

    def plano_route(request: Request):
        require_account(request, "plano-isd")
        return {"ok": True}
    app.add_api_route("/api/v1/scoped", fedex_route, methods=["GET"], dependencies=[Depends(require_role("executive", "admin", scoped=True))])
    app.add_api_route("/api/v1/scoped-plano", plano_route, methods=["GET"], dependencies=[Depends(require_role("executive", "admin", scoped=True))])
    pat = TestClient(app)
    assert signin(pat, "pat") == 200
    assert pat.get("/api/v1/auth/me").json()["user"]["accounts"] == ["plano-isd"]
    assert pat.get("/api/v1/view").status_code == 403  # an every-account view
    assert pat.get("/api/v1/scoped").status_code == 403  # another account
    assert pat.get("/api/v1/scoped-plano").status_code == 200
    assert c.get("/api/v1/scoped").status_code == 200  # administrators see everything

    c.patch("/api/v1/users/pat", json={"accounts": []})  # every account again
    users.clear_cache()
    assert pat.get("/api/v1/view").status_code == 200 and pat.get("/api/v1/auth/me").json()["user"]["accounts"] is None

    assert scope_clause("featured", None) == ("", {})
    assert scope_clause("featured", frozenset({"plano-isd"}))[1] == {"scope": ["plano-isd"]}
    for account in ("other", "fedex"):
        with pytest.raises(HTTPException) as refused:
            scope_clause(account, frozenset({"plano-isd"}))
        assert refused.value.status_code == 403

    # Routes that take `request: Request = None` still receive the request from FastAPI.
    seen = []

    def probe(q: str = Query("a"), request: Request = None):
        seen.append(request is not None)
        return {}
    app.add_api_route("/api/v1/probe2", probe, methods=["GET"])
    TestClient(app).get("/api/v1/probe2")
    assert seen == [True]
