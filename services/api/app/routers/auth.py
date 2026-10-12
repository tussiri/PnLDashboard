"""Sign-in (password or Microsoft), sign-out, the current-session probe, first-administrator setup and
changing one's own password (routes under /auth; the password change needs a session)."""
from __future__ import annotations

import hmac
import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from .. import entra, permissions, users
from ..auth import (COOKIE_NAME, SESSION_TTL_SECONDS, User, get_auth_settings, sign_session, sign_value, verify_password,
                    verify_value)
from ..common import current_user

log = logging.getLogger(__name__)

router = APIRouter()

# Fail fast: an invalid or incomplete auth configuration must stop the API from starting.
get_auth_settings()

FAILED_LOGIN_DELAY_SECONDS = 0.3
#: Carries state, nonce and PKCE verifier from /auth/entra/start to the callback (signed, short-lived).
FLOW_COOKIE = "crane_entra_flow"
FLOW_PURPOSE = "entra-flow"


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=1000)


class PasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=1000)
    new_password: str = Field(min_length=1, max_length=1000)


class SetupBody(BaseModel):
    token: str = Field(min_length=1, max_length=500)
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=1000)


def request_is_https(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


@router.get("/auth/mode")
def auth_mode() -> dict[str, Any]:
    """Which sign-in mode the API runs in (dev shows the development-user notice), whether Microsoft
    sign-in is on and who may still use a password ("all" or "admins")."""
    settings = get_auth_settings()
    return {"mode": settings.mode, "microsoft": settings.entra is not None, "password": settings.password_login}


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
def login(body: LoginBody, request: Request, response: Response) -> dict[str, Any]:
    settings = get_auth_settings()
    name = body.username.strip()
    # APP_USERS_JSON (and development) users first; they win on a name clash with a database user.
    user = settings.authenticate(name, body.password) if name in settings.users else users.authenticate(name, body.password)
    if user is None:
        time.sleep(FAILED_LOGIN_DELAY_SECONDS)
        raise HTTPException(status_code=401, detail="Invalid username or password")
    # APP_USERS_JSON users have no Microsoft route in, so they keep their password whatever the role.
    if settings.password_login == "admins" and user.role != "admin" and name not in settings.users:
        raise HTTPException(status_code=403, detail="Sign in with Microsoft")
    set_session_cookie(response, request, user)
    return {"user": user_payload(user)}


def _to_login(error: str) -> RedirectResponse:
    """Back to the sign-in page, which explains `error` (cancelled, failed, expired, not_provisioned, off)."""
    return RedirectResponse(f"/?signin_error={error}", status_code=303)


@router.get("/auth/entra/start")
def entra_start(request: Request) -> RedirectResponse:
    """Leave for Microsoft's sign-in page; it returns to /auth/callback/entra."""
    settings = get_auth_settings()
    if settings.entra is None:
        return _to_login("off")
    flow = entra.new_flow()
    redirect = RedirectResponse(entra.authorization_url(settings.entra, flow), status_code=303)
    redirect.set_cookie(FLOW_COOKIE, sign_value(flow.encode(), settings.session_secret, FLOW_PURPOSE), max_age=entra.FLOW_TTL_SECONDS,
                        httponly=True, samesite="lax", secure=request_is_https(request), path="/api/v1/auth")
    return redirect


@router.get("/auth/callback/entra")
def entra_callback(request: Request, code: str = "", state: str = "", error: str = "") -> RedirectResponse:
    """Microsoft returns here. Signs in the active dashboard user whose username is the person's work
    email; anyone else is refused (an administrator adds them in Admin > Users first)."""
    settings = get_auth_settings()
    if settings.entra is None:
        return _to_login("off")
    payload = verify_value(request.cookies.get(FLOW_COOKIE), settings.session_secret, FLOW_PURPOSE)
    flow = entra.Flow.decode(payload) if payload else None
    outcome: RedirectResponse
    if error:
        outcome = _to_login("cancelled" if error == "access_denied" else "failed")
    elif flow is None or flow.expires < time.time():
        outcome = _to_login("expired")
    elif not code or not hmac.compare_digest(state.encode(), flow.state.encode()):
        outcome = _to_login("failed")
    else:
        try:
            claims = entra.id_token_claims(entra.exchange_code(settings.entra, code, flow.verifier))
            email = entra.verified_email(settings.entra, claims, flow.nonce)
        except entra.EntraError as exc:
            log.warning("Microsoft sign-in refused: %s", exc)
            outcome = _to_login(exc.code)
        else:
            user = users.microsoft_user(email)
            if user is None:
                log.info("Microsoft sign-in for an email with no active dashboard user")
                outcome = _to_login("not_provisioned")
            else:
                outcome = RedirectResponse("/", status_code=303)
                set_session_cookie(outcome, request, user)
    outcome.delete_cookie(FLOW_COOKIE, path="/api/v1/auth", httponly=True, samesite="lax", secure=request_is_https(request))
    return outcome


def user_payload(user: User) -> dict[str, Any]:
    """The browser's view of a user: role, the accounts it may see (null = every account) and its
    effective permissions (app/permissions.py)."""
    return {**user.as_dict(), "accounts": list(user.accounts) if user.accounts and user.role != "admin" else None,
            "permissions": permissions.effective(user.role, user.permissions)}


def setup_needed() -> bool:
    """The first-administrator page is open: a setup token is configured and no user exists yet
    (development accounts do not count)."""
    settings = get_auth_settings()
    return bool(settings.setup_token) and not settings.configured_users() and not users.any_users()


@router.get("/auth/setup")
def setup_status() -> dict[str, bool]:
    return {"needed": setup_needed()}


@router.post("/auth/setup", status_code=201)
def setup(body: SetupBody, request: Request, response: Response) -> dict[str, Any]:
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
    return {"user": user_payload(user)}


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
    return {"user": user_payload(user)}


@router.post("/auth/password")
def change_password(body: PasswordBody, request: Request, response: Response) -> dict[str, Any]:
    """The signed-in user changes their own password, any role. Needs the current password; ends every
    other session (as an administrator's reset does) and keeps this one signed in."""
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in required")
    if user.username in get_auth_settings().users:
        raise HTTPException(status_code=409, detail="This sign-in is defined in APP_USERS_JSON; change it there")
    record = users.lookup(user.username)
    if record is None or not verify_password(body.current_password, record.password_hash):
        time.sleep(FAILED_LOGIN_DELAY_SECONDS)
        # 403, not 401: a wrong current password must not read as a lost session.
        raise HTTPException(status_code=403, detail="The current password is not correct")
    try:
        updated = users.update(user.username, user.username, password=body.new_password)
    except users.UserError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    set_session_cookie(response, request, User(updated.username, updated.role))
    return {"user": user_payload(user)}
