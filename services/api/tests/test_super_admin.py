"""Super administrators (APP_SUPER_ADMINS) and the analytics suite routes they alone may read."""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthSettings, User, hash_password, parse_super_admins, reset_auth_settings
from app.common import require_super_admin
from app.routers import auth as auth_router

SECRET = "unit-test-session-secret-that-is-long-enough-0123456789"
PASSWORD = "a-long-enough-password"


def _users_json() -> str:
    encoded = hash_password(PASSWORD, iterations=1000)
    rows = [("Owner", "admin"), ("ops", "admin"), ("cfo", "executive"), ("omar", "analyst")]
    return "[" + ",".join(f'{{"username":"{name}","role":"{role}","password_hash":"{encoded}"}}' for name, role in rows) + "]"


def _load(super_admins: str | None) -> AuthSettings:
    env = {"APP_AUTH_MODE": "required", "APP_SESSION_SECRET": SECRET, "APP_USERS_JSON": _users_json()}
    if super_admins is not None:
        env["APP_SUPER_ADMINS"] = super_admins
    return AuthSettings.load(env)


@pytest.fixture(autouse=True)
def _settings():
    # "cfo" is listed but is an executive: the list never raises a role.
    reset_auth_settings(_load("owner, cfo"))
    yield
    reset_auth_settings(None)


def client(admin_token: str = "tok") -> TestClient:
    from app.config import settings as app_settings

    object.__setattr__(app_settings, "ingestion_admin_token", admin_token)
    app = FastAPI()
    app.include_router(auth_router.router, prefix="/api/v1")

    def route():
        return {"ok": True}

    # As app/main.py mounts the reporting, labor and forecast routers.
    app.add_api_route("/api/v1/portfolio/summary", route, methods=["GET"], dependencies=[Depends(require_super_admin)])
    app.add_api_route("/api/v1/forecasts/rebuild", route, methods=["POST"], dependencies=[Depends(require_super_admin)])
    return TestClient(app)


def login(c: TestClient, username: str) -> dict:
    c.cookies.clear()
    response = c.post("/api/v1/auth/login", json={"username": username, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["user"]


def test_parse_super_admins() -> None:
    assert parse_super_admins(None) == frozenset()
    assert parse_super_admins("") == frozenset()
    assert parse_super_admins(" Owner,ops  jane@crane.example ,") == {"owner", "ops", "jane@crane.example"}


def test_nobody_is_a_super_admin_unless_listed() -> None:
    for settings in (_load(None), _load(""), AuthSettings.load({"APP_AUTH_MODE": "dev"})):
        assert settings.super_admins == frozenset()
        assert not settings.is_super_admin(User("Owner", "admin"))
        assert not settings.is_super_admin(User("admin", "admin"))


def test_only_a_listed_administrator_is_a_super_admin() -> None:
    settings = _load("owner, cfo")
    assert settings.is_super_admin(User("Owner", "admin"))  # names compare without case
    assert not settings.is_super_admin(User("ops", "admin"))  # an administrator, not listed
    assert not settings.is_super_admin(User("cfo", "executive"))  # listed, not an administrator
    assert not settings.is_super_admin(None)


def test_sign_in_reports_super_admin() -> None:
    c = client()
    assert login(c, "Owner")["super_admin"] is True
    assert c.get("/api/v1/auth/me").json()["user"]["super_admin"] is True
    for name in ("ops", "cfo", "omar"):
        assert login(c, name)["super_admin"] is False


@pytest.mark.parametrize(("username", "status"), [(None, 401), ("cfo", 403), ("omar", 403), ("ops", 403), ("Owner", 200)])
def test_suite_reads_need_a_super_admin_session(username: str | None, status: int) -> None:
    c = client()
    if username:
        login(c, username)
    assert c.get("/api/v1/portfolio/summary").status_code == status
    # The admin token does not open reads: it stands in for a session on mutating requests only.
    assert c.get("/api/v1/portfolio/summary", headers={"X-Admin-Token": "tok"}).status_code == status


def test_suite_writes_accept_the_admin_token_or_a_super_admin_session() -> None:
    c = client()
    assert c.post("/api/v1/forecasts/rebuild").status_code == 401
    assert c.post("/api/v1/forecasts/rebuild", headers={"X-Admin-Token": "wrong"}).status_code == 401
    assert c.post("/api/v1/forecasts/rebuild", headers={"X-Admin-Token": "tok"}).status_code == 200
    login(c, "ops")
    assert c.post("/api/v1/forecasts/rebuild").status_code == 403
    assert c.post("/api/v1/forecasts/rebuild", headers={"X-Admin-Token": "tok"}).status_code == 200
    login(c, "Owner")
    assert c.post("/api/v1/forecasts/rebuild").status_code == 200


def test_main_mounts_the_suite_routers_behind_super_admin() -> None:
    import pathlib

    source = (pathlib.Path(__file__).resolve().parents[1] / "app" / "main.py").read_text()
    for name in ("reporting", "labor", "forecast"):
        assert f'app.include_router({name}.router, prefix=API_PREFIX, tags=["{name}"], dependencies=[Depends(require_super_admin)])' in source
