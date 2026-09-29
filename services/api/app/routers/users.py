"""Admin > Users: list, add and change sign-in users (administrators only).

Database users are editable. APP_USERS_JSON users are listed read-only (source `environment`);
the development accounts only in dev mode (source `development`). Hashes are never returned.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import users
from ..auth import User, get_auth_settings
from ..common import current_user, require_admin
from .auth import set_session_cookie

router = APIRouter(dependencies=[Depends(require_admin)])


class UserIn(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    role: str
    password: str = Field(min_length=1, max_length=1000)


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=1, max_length=1000)


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
    env = [{"username": u.username, "role": u.role, "active": True, "source": "development" if settings.is_dev_user(u) else "environment",
            "created_at": None, "created_by": None, "last_login_at": None} for u in settings.users.values()]
    taken = {u["username"] for u in env}
    return {"users": env + [u for u in users.listing() if u["username"] not in taken]}


@router.post("/users", status_code=201)
def create_user(body: UserIn, request: Request) -> dict[str, Any]:
    if body.username.strip() in get_auth_settings().users:
        raise HTTPException(status_code=409, detail=f"{body.username.strip()} is defined in APP_USERS_JSON")
    try:
        return {"user": users.create(body.username, body.role, body.password, _actor(request)).public()}
    except users.UserError as exc:
        raise _fail(exc) from exc


@router.patch("/users/{username}")
def update_user(username: str, body: UserPatch, request: Request, response: Response) -> dict[str, Any]:
    if username in get_auth_settings().users:
        raise HTTPException(status_code=409, detail=f"{username} is defined in APP_USERS_JSON; change it there")
    actor = _actor(request)
    try:
        updated = users.update(username, actor, role=body.role, active=body.active, password=body.password,
                               environment_admins=environment_admins())
    except users.UserError as exc:
        raise _fail(exc) from exc
    # A password reset ends every earlier session; keep the administrator who reset their own signed in.
    if body.password is not None and updated.active and actor.lower() == updated.username.lower():
        set_session_cookie(response, request, User(updated.username, updated.role))
    return {"user": updated.public()}
