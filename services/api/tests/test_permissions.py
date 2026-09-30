"""Per-user permissions (app/permissions.py): role defaults, overrides, the matrix routes and enforcement."""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from app import permissions, users
from app.auth import AuthSettings, User, parse_users_json, reset_auth_settings, hash_password
from app.routers import auth as auth_router
from app.routers import users as users_router
from tests.test_users import PASSWORD, SECRET, SETUP, MemoryStore



@pytest.fixture()
def store():
    s = MemoryStore()
    users.set_store(s)
    reset_auth_settings(AuthSettings.load({"APP_AUTH_MODE": "required", "APP_SESSION_SECRET": SECRET, "APP_SETUP_TOKEN": SETUP}))
    yield s
    users.set_store(users.PostgresUserStore())
    reset_auth_settings(None)


def test_role_defaults_and_overrides():
    assert permissions.effective("admin", {"view.company": False})["view.company"]  # administrators hold everything
    ex = permissions.effective("executive", None)
    assert ex["view.company"] and ex["tab.map"] and not ex["view.analytics"] and not ex["data.staffing"]
    an = permissions.effective("analyst", {"view.analytics": True, "tab.vendors": False})
    assert an["view.analytics"] and not an["tab.vendors"] and an["data.staffing"]
    assert permissions.overrides_of("executive", ex) == {}
    assert permissions.overrides_of("executive", {**ex, "view.analytics": True, "tab.map": False}) == {"view.analytics": True, "tab.map": False}
    assert set(permissions.catalog()["defaults"]) == {"executive", "analyst", "admin"}
    with pytest.raises(ValueError):
        permissions.validate({"view.nothing": True})
    with pytest.raises(ValueError):
        permissions.validate({"view.company": "yes"})
    assert permissions.validate(None) == {}


def test_allowed_and_strip():
    boss = User("boss", "admin")
    pat = User("pat", "executive", None, {"data.allocations": False})
    assert permissions.allowed(None, "data.allocations") and permissions.allowed(boss, "data.allocations")
    assert not permissions.allowed(pat, "data.allocations") and permissions.allowed(pat, "tab.map")
    rows = [{"labor": 1.0, "alloc_management": 2.0, "alloc_burden": 3.0, "alloc_overhead": 4.0}]
    assert permissions.strip(boss, [dict(rows[0])]) == rows
    assert permissions.strip(pat, [dict(rows[0])]) == [{"labor": 1.0}]
    with pytest.raises(ValueError):
        permissions.allowed(pat, "tab.nothing")


def test_environment_users_carry_overrides():
    raw = f'[{{"username": "cfo", "role": "executive", "password_hash": "{hash_password("x" * 12, iterations=1000)}", "permissions": {{"view.analytics": true}}}}]'
    assert parse_users_json(raw)["cfo"].permissions == {"view.analytics": True}
    with pytest.raises(Exception):
        parse_users_json(raw.replace("true", '"yes"'))


def client() -> TestClient:
    from app.config import settings as app_settings

    object.__setattr__(app_settings, "ingestion_admin_token", "tok")
    app = FastAPI()
    app.include_router(auth_router.router, prefix="/api/v1")
    app.include_router(users_router.router, prefix="/api/v1")
    app.add_api_route("/api/v1/company", lambda: {"ok": True}, methods=["GET"], dependencies=[Depends(permissions.require_permission("view.company"))])
    app.add_api_route("/api/v1/staffing", lambda: {"ok": True}, methods=["GET"], dependencies=[Depends(permissions.require_permission("data.staffing"))])

    def rows(request: Request):
        return {"rows": permissions.strip(auth_router.current_user(request), [{"labor": 1.0, "alloc_burden": 2.0}])}

    app.add_api_route("/api/v1/rows", rows, methods=["GET"])
    return TestClient(app)


def signin(c: TestClient, username: str) -> int:
    c.cookies.clear()
    return c.post("/api/v1/auth/login", json={"username": username, "password": PASSWORD}).status_code


def test_matrix_routes_and_enforcement(store):
    c = client()
    c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "boss", "password": PASSWORD})
    cat = c.get("/api/v1/users/permissions").json()
    assert [p["key"] for p in cat["permissions"]] == list(permissions.KEYS) and cat["defaults"]["executive"]["view.company"]
    assert c.post("/api/v1/users", json={"username": "pat", "role": "executive", "password": PASSWORD, "permissions": {"nope": True}}).status_code == 422
    made = c.post("/api/v1/users", json={"username": "pat", "role": "executive", "password": PASSWORD, "permissions": {"data.staffing": True}})
    assert made.status_code == 201 and made.json()["user"]["permissions"] == {"data.staffing": True}
    assert made.json()["user"]["effective_permissions"]["data.staffing"] and not made.json()["user"]["effective_permissions"]["view.analytics"]
    listed = {u["username"]: u for u in c.get("/api/v1/users").json()["users"]}
    assert listed["pat"]["permissions"] == {"data.staffing": True} and listed["boss"]["effective_permissions"]["view.analytics"]

    pat = client()
    assert signin(pat, "pat") == 200
    me = pat.get("/api/v1/auth/me").json()["user"]
    assert me["permissions"]["data.staffing"] and me["permissions"]["view.company"]
    assert pat.get("/api/v1/company").status_code == 200 and pat.get("/api/v1/staffing").status_code == 200
    assert pat.get("/api/v1/rows").json()["rows"] == [{"labor": 1.0, "alloc_burden": 2.0}]

    r = c.patch("/api/v1/users/pat", json={"permissions": {"view.company": False, "data.allocations": False}})
    assert r.status_code == 200 and r.json()["user"]["permissions"] == {"view.company": False, "data.allocations": False}
    users.clear_cache()
    assert pat.get("/api/v1/company").status_code == 403
    assert pat.get("/api/v1/staffing").status_code == 403  # back to the executive default
    assert pat.get("/api/v1/rows").json()["rows"] == [{"labor": 1.0}]
    assert c.get("/api/v1/rows").json()["rows"] == [{"labor": 1.0, "alloc_burden": 2.0}]

    assert c.patch("/api/v1/users/pat", json={"permissions": {}}).json()["user"]["permissions"] == {}  # the role's defaults again
    users.clear_cache()
    assert pat.get("/api/v1/company").status_code == 200
    # An unrelated change keeps the overrides.
    c.patch("/api/v1/users/pat", json={"permissions": {"tab.map": False}})
    assert c.patch("/api/v1/users/pat", json={"active": True}).json()["user"]["permissions"] == {"tab.map": False}
