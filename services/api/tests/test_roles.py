"""Roles defined in the dashboard (app/roles.py, /users/roles) and the gates that read them."""
from __future__ import annotations

from fastapi import Depends
from fastapi.testclient import TestClient

from app import permissions, roles, users
from app.common import require_access
from tests.test_users import PASSWORD, SETUP, client, settings, signin, store  # noqa: F401 - store is a fixture


def admin_client():
    settings(APP_SETUP_TOKEN=SETUP)
    c = client()
    c.post("/api/v1/auth/setup", json={"token": SETUP, "username": "boss", "password": PASSWORD})
    c.app.add_api_route("/api/v1/reporting", lambda: {"ok": True}, methods=["GET"], dependencies=[Depends(require_access("view.reporting"))])
    return c


def test_built_in_roles_are_listed_and_fixed_ones_cannot_change(store):
    c = admin_client()
    listed = {r["slug"]: r for r in c.get("/api/v1/users/roles").json()["roles"]}
    assert list(listed)[0] == "admin" and list(listed)[-1] == "none"
    assert listed["admin"]["users"] == 1 and not listed["admin"]["editable"] and not listed["none"]["editable"]
    assert listed["executive"]["editable"] and not listed["executive"]["deletable"]
    assert not listed["executive"]["permissions"]["view.reporting"] and listed["analyst"]["permissions"]["view.reporting"]
    assert c.patch("/api/v1/users/roles/admin", json={"name": "Boss"}).status_code == 409
    assert c.patch("/api/v1/users/roles/none", json={"permissions": {"tab.map": True}}).status_code == 409
    assert c.delete("/api/v1/users/roles/executive").status_code == 409


def test_a_custom_role_grants_exactly_its_permissions(store):
    c = admin_client()
    made = c.post("/api/v1/users/roles", json={"name": "Regional manager", "copy_from": "executive", "permissions": {"tab.map": False, "view.reporting": True}})
    assert made.status_code == 201
    role = made.json()["role"]
    assert role["slug"] == "regional-manager" and not role["built_in"]
    assert role["permissions"]["tab.sites"] and not role["permissions"]["tab.map"] and role["permissions"]["view.reporting"]
    assert c.post("/api/v1/users/roles", json={"name": "regional  MANAGER"}).status_code == 409  # names are unique regardless of case
    assert c.post("/api/v1/users/roles", json={"name": "Admin"}).status_code == 422  # a built-in slug
    assert c.post("/api/v1/users/roles", json={"name": "X", "permissions": {}}).status_code == 422
    assert c.post("/api/v1/users/roles", json={"name": "Odd", "permissions": {"tab.nothing": True}}).status_code == 422

    assert c.post("/api/v1/users", json={"username": "rm", "role": "regional-manager", "password": PASSWORD}).status_code == 201
    rm = TestClient(c.app)
    assert signin(rm, "rm") == 200
    me = rm.get("/api/v1/auth/me").json()["user"]
    assert me["role_name"] == "Regional manager" and me["permissions"]["view.reporting"] and not me["permissions"]["tab.map"]
    assert rm.get("/api/v1/view").status_code == 200 and rm.get("/api/v1/reporting").status_code == 200

    # Editing the role reaches the signed-in user: only the keys named change.
    assert c.patch("/api/v1/users/roles/regional-manager", json={"permissions": {"view.reporting": False}}).status_code == 200
    roles.clear_cache()
    assert rm.get("/api/v1/reporting").status_code == 403
    assert rm.get("/api/v1/auth/me").json()["user"]["permissions"]["tab.sites"]

    # A held role cannot be deleted; once nobody holds it, it can.
    assert c.delete("/api/v1/users/roles/regional-manager").status_code == 409
    c.patch("/api/v1/users/rm", json={"role": "analyst"})
    assert c.delete("/api/v1/users/roles/regional-manager").status_code == 200
    assert c.post("/api/v1/users", json={"username": "rm2", "role": "regional-manager", "password": PASSWORD}).status_code == 422


def test_presets_can_be_edited_and_reset(store):
    c = admin_client()
    r = c.patch("/api/v1/users/roles/executive", json={"name": "Leadership", "permissions": {"view.analytics": True}})
    assert r.status_code == 200 and r.json()["role"]["name"] == "Leadership" and r.json()["role"]["permissions"]["view.analytics"]
    assert permissions.effective("executive", None)["view.analytics"]
    r = c.post("/api/v1/users/roles/executive/reset")
    assert r.json()["role"]["name"] == "Executive" and not r.json()["role"]["permissions"]["view.analytics"]
    assert c.post("/api/v1/users/roles/regional/reset").status_code == 409


def test_executive_lacks_reporting_and_no_access_opens_nothing(store):
    c = admin_client()
    c.post("/api/v1/users", json={"username": "exec", "role": "executive", "password": PASSWORD})
    c.post("/api/v1/users", json={"username": "waiting", "role": "none", "password": PASSWORD})
    e, w = TestClient(c.app), TestClient(c.app)
    signin(e, "exec")
    signin(w, "waiting")
    assert e.get("/api/v1/view").status_code == 200 and e.get("/api/v1/reporting").status_code == 403
    assert w.get("/api/v1/view").status_code == 403 and w.get("/api/v1/auth/me").json()["user"]["role"] == "none"
    assert permissions.effective("none", {"tab.map": True})["tab.map"] is False  # overrides cannot lift No access


def test_roles_need_an_administrator(store):
    c = admin_client()
    c.post("/api/v1/users", json={"username": "ana", "role": "analyst", "password": PASSWORD})
    ana = client()
    signin(ana, "ana")
    assert ana.get("/api/v1/users/roles").status_code == 401
    assert ana.post("/api/v1/users/roles", json={"name": "Mine"}).status_code == 401
    users.clear_cache()
