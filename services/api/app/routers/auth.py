"""Sign-in, sign-out and the current-session probe (public routes under /auth)."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..auth import COOKIE_NAME, SESSION_TTL_SECONDS, get_auth_settings, sign_session
from ..common import current_user

router = APIRouter()

# Fail fast: an invalid or incomplete auth configuration must stop the API from starting.
get_auth_settings()

FAILED_LOGIN_DELAY_SECONDS = 0.3


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=1000)


def request_is_https(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


@router.get("/auth/mode")
def auth_mode() -> dict[str, str]:
    """Which sign-in mode the API runs in (dev shows the development-user notice)."""
    return {"mode": get_auth_settings().mode}


@router.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response) -> dict[str, dict[str, str]]:
    settings = get_auth_settings()
    user = settings.authenticate(body.username, body.password)
    if user is None:
        time.sleep(FAILED_LOGIN_DELAY_SECONDS)
        raise HTTPException(status_code=401, detail="Invalid username or password")
    response.set_cookie(
        COOKIE_NAME,
        sign_session(user, settings.session_secret),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=request_is_https(request),
        path="/",
    )
    return {"user": user.as_dict()}


@router.post("/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=request_is_https(request))
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request) -> dict[str, dict[str, str]]:
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in required")
    return {"user": user.as_dict()}
