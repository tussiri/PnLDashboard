"""Sign-in, sign-out, the current-session probe and first-administrator setup (public routes under /auth)."""
from __future__ import annotations

import hmac
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import users
from ..auth import COOKIE_NAME, SESSION_TTL_SECONDS, User, get_auth_settings, sign_session
from ..common import current_user

router = APIRouter()

# Fail fast: an invalid or incomplete auth configuration must stop the API from starting.
get_auth_settings()

FAILED_LOGIN_DELAY_SECONDS = 0.3


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=1000)


class SetupBody(BaseModel):
    token: str = Field(min_length=1, max_length=500)
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=1000)


def request_is_https(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


@router.get("/auth/mode")
def auth_mode() -> dict[str, str]:
    """Which sign-in mode the API runs in (dev shows the development-user notice)."""
    return {"mode": get_auth_settings().mode}


def set_session_cookie(response: Response, request: Request, user: User) -> None:
    response.set_cookie(
        COOKIE_NAME,
        sign_session(user, get_auth_settings().session_secret),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=request_is_https(request),
        path="/",
    )


@router.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response) -> dict[str, dict[str, str]]:
    settings = get_auth_settings()
    name = body.username.strip()
    # APP_USERS_JSON (and development) users first; they win on a name clash with a database user.
    user = settings.authenticate(name, body.password) if name in settings.users else users.authenticate(name, body.password)
    if user is None:
        time.sleep(FAILED_LOGIN_DELAY_SECONDS)
        raise HTTPException(status_code=401, detail="Invalid username or password")
    set_session_cookie(response, request, user)
    return {"user": user.as_dict()}


def setup_needed() -> bool:
    """The first-administrator page is open: a setup token is configured and no user exists yet
    (development accounts do not count)."""
    settings = get_auth_settings()
    return bool(settings.setup_token) and not settings.configured_users() and not users.any_users()


@router.get("/auth/setup")
def setup_status() -> dict[str, bool]:
    return {"needed": setup_needed()}


@router.post("/auth/setup", status_code=201)
def setup(body: SetupBody, request: Request, response: Response) -> dict[str, dict[str, str]]:
    """Create the first administrator and sign them in. Closed for good once any user exists."""
    settings = get_auth_settings()
    if not settings.setup_token:
        raise HTTPException(status_code=404, detail="Setup is not enabled")
    if not setup_needed():
        raise HTTPException(status_code=409, detail="Setup is already complete")
    if not hmac.compare_digest(body.token.strip().encode(), settings.setup_token.encode()):
        time.sleep(FAILED_LOGIN_DELAY_SECONDS)
        raise HTTPException(status_code=401, detail="The setup code is not correct")
    try:
        created = users.create(body.username, "admin", body.password, actor="setup", only_if_empty=True)
    except users.UserError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    user = User(created.username, created.role)
    set_session_cookie(response, request, user)
    return {"user": user.as_dict()}


@router.post("/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=request_is_https(request))
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request) -> dict[str, Any]:
    """The signed-in user, with `accounts` (the slugs they may see; null = every account)."""
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in required")
    return {"user": {**user.as_dict(), "accounts": list(user.accounts) if user.accounts and user.role != "admin" else None}}
