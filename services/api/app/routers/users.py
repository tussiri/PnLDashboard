"""Admin > Users: list, add and change sign-in users (administrators only).

Database users are editable. APP_USERS_JSON users are listed read-only (source `environment`);
the development accounts only in dev mode (source `development`). Hashes are never returned.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import permissions, roles, users
from ..auth import User, get_auth_settings
from ..common import current_user, require_admin
from .auth import set_session_cookie

router = APIRouter(dependencies=[Depends(require_admin)])


class UserIn(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    role: str
    password: str = Field(min_length=1, max_length=1000)
    #: Accounts the user may see; empty or absent = every account.
    accounts: list[str] | None = None
    #: Permission overrides over the role's defaults; absent or {} = the defaults.
    permissions: dict[str, bool] | None = None


class RoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    #: Permissions over the starting point (``copy_from``'s, or all off); absent = the starting point.
    permissions: dict[str, bool] | None = None
    copy_from: str | None = None


class RolePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    #: Keys named here change; keys left out keep their value.
    permissions: dict[str, bool] | None = None


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=1, max_length=1000)
    #: Present (even as []) = replace; [] = every account.
    accounts: list[str] | None = None
    #: Present = replace the overrides; {} = the role's defaults.
    permissions: dict[str, bool] | None = None


def known_accounts() -> set[str]:
    from ..db import connection

    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT slug FROM ops.account")
        return {r["slug"] for r in cursor.fetchall()}


def _actor(request: Request) -> str:
    user = current_user(request)
    return user.username if user is not None else "admin-token"


def _fail(exc: users.UserError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


def environment_admins() -> int:
    return sum(1 for u in get_auth_settings().configured_users() if u.role == "admin")


@router.get("/users")
def list_users() -> dict[str, Any]:
    settings = get_auth_settings()
    env = [{"username": u.username, "role": u.role, "role_name": roles.name(u.role), "active": True, "source": "development" if settings.is_dev_user(u) else "environment",
            "accounts": list(u.accounts) if u.accounts else None, "permissions": dict(u.permissions or {}),
            "effective_permissions": permissions.effective(u.role, u.permissions), "created_at": None, "created_by": None, "last_login_at": None}
           for u in settings.users.values()]
    taken = {u["username"] for u in env}
    return {"users": env + [u for u in users.listing() if u["username"] not in taken]}


@router.get("/users/permissions")
def permission_catalog() -> dict[str, Any]:
    """Every permission (key, group, label) and each role's permissions."""
    return permissions.catalog()


def _role_holders() -> dict[str, int]:
    """Users per role slug, database and environment users alike."""
    counts: dict[str, int] = {}
    for u in [*users.listing(), *({"role": r.role} for r in get_auth_settings().users.values())]:
        counts[u["role"]] = counts.get(u["role"], 0) + 1
    return counts


def _role_fail(exc: roles.RoleError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/users/roles")
def list_roles() -> dict[str, Any]:
    """Every role with its permissions and how many users hold it."""
    holders = _role_holders()
    return {"roles": [r.public(holders.get(r.slug, 0)) for r in roles.listing()]}


@router.post("/users/roles", status_code=201)
def create_role(body: RoleIn, request: Request) -> dict[str, Any]:
    try:
        return {"role": roles.create(body.name, body.permissions, _actor(request), copy_from=body.copy_from).public()}
    except roles.RoleError as exc:
        raise _role_fail(exc) from exc


@router.patch("/users/roles/{slug}")
def update_role(slug: str, body: RolePatch, request: Request) -> dict[str, Any]:
    try:
        role = roles.update(slug, _actor(request), name_=body.name, permissions_=body.permissions)
    except roles.RoleError as exc:
        raise _role_fail(exc) from exc
    return {"role": role.public(_role_holders().get(role.slug, 0))}


@router.post("/users/roles/{slug}/reset")
def reset_role(slug: str, request: Request) -> dict[str, Any]:
    """Executive or Analyst back to the shipped name and permissions."""
    try:
        role = roles.reset(slug, _actor(request))
    except roles.RoleError as exc:
        raise _role_fail(exc) from exc
    return {"role": role.public(_role_holders().get(role.slug, 0))}


@router.delete("/users/roles/{slug}")
def delete_role(slug: str) -> dict[str, bool]:
    try:
        roles.delete(slug, _role_holders().get(slug, 0))
    except roles.RoleError as exc:
        raise _role_fail(exc) from exc
    return {"ok": True}


@router.post("/users", status_code=201)
def create_user(body: UserIn, request: Request) -> dict[str, Any]:
    if body.username.strip() in get_auth_settings().users:
        raise HTTPException(status_code=409, detail=f"{body.username.strip()} is defined in APP_USERS_JSON")
    try:
        accounts = users.normalize_accounts(body.accounts, known_accounts() if body.accounts else None)
        return {"user": users.create(body.username, body.role, body.password, _actor(request), accounts=accounts, permissions_=body.permissions).public()}
    except users.UserError as exc:
        raise _fail(exc) from exc


@router.patch("/users/{username}")
def update_user(username: str, body: UserPatch, request: Request, response: Response) -> dict[str, Any]:
    if username in get_auth_settings().users:
        raise HTTPException(status_code=409, detail=f"{username} is defined in APP_USERS_JSON; change it there")
    actor = _actor(request)
    try:
        accounts = (users.normalize_accounts(body.accounts, known_accounts() if body.accounts else None)
                    if "accounts" in body.model_fields_set else users.UNCHANGED)
        updated = users.update(username, actor, role=body.role, active=body.active, password=body.password, environment_admins=environment_admins(),
                               accounts=accounts, permissions_=body.permissions if "permissions" in body.model_fields_set else users.UNCHANGED)
    except users.UserError as exc:
        raise _fail(exc) from exc
    # A password reset ends every earlier session; keep the administrator who reset their own signed in.
    if body.password is not None and updated.active and actor.lower() == updated.username.lower():
        set_session_cookie(response, request, User(updated.username, updated.role))
    return {"user": updated.public()}
