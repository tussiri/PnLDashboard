"""Microsoft 365 (Entra ID) sign-in: OpenID Connect authorization-code flow with PKCE.

Standard library plus httpx only. The ID token comes straight from Microsoft's token endpoint over
TLS in exchange for the code, the PKCE verifier and the client secret, so its claims are checked
(issuer, audience, tenant, expiry, nonce) but its signature is not (OpenID Connect Core 3.1.3.7,
step 6, allows this for a token received directly from the token endpoint).

Nobody is created here: a Microsoft account signs in only when its email is already the username of
an active dashboard user (app/routers/auth.py). Configuration and the app registration are in
docs/auth-rbac.md (Microsoft sign-in).
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

log = logging.getLogger(__name__)

AUTHORITY = "https://login.microsoftonline.com"
SCOPE = "openid profile email"
#: How long the browser may spend at Microsoft between leaving and coming back.
FLOW_TTL_SECONDS = 10 * 60
CLOCK_SKEW_SECONDS = 300
TOKEN_TIMEOUT_SECONDS = 15


class EntraError(Exception):
    """A sign-in that cannot complete. `code` is what the login page is told (never the details)."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code


@dataclass(frozen=True)
class EntraConfig:
    tenant_id: str
    client_id: str
    client_secret: str
    redirect_uri: str

    @property
    def issuer(self) -> str:
        return f"{AUTHORITY}/{self.tenant_id}/v2.0"

    @property
    def token_url(self) -> str:
        return f"{AUTHORITY}/{self.tenant_id}/oauth2/v2.0/token"


@dataclass(frozen=True)
class Flow:
    """What the browser carries (in a signed cookie) from the start of a sign-in to its return."""
    state: str
    nonce: str
    verifier: str
    expires: int

    def encode(self) -> bytes:
        return f"{self.state}|{self.nonce}|{self.verifier}|{self.expires}".encode("ascii")

    @classmethod
    def decode(cls, payload: bytes) -> "Flow | None":
        try:
            state, nonce, verifier, expires = payload.decode("ascii").split("|")
            return cls(state, nonce, verifier, int(expires))
        except (UnicodeDecodeError, ValueError):
            return None


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def new_flow(now: float | None = None) -> Flow:
    return Flow(secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48),
                int((time.time() if now is None else now) + FLOW_TTL_SECONDS))


def authorization_url(config: EntraConfig, flow: Flow) -> str:
    challenge = _b64url(hashlib.sha256(flow.verifier.encode("ascii")).digest())
    params = {
        "client_id": config.client_id,
        "response_type": "code",
        "redirect_uri": config.redirect_uri,
        "response_mode": "query",
        "scope": SCOPE,
        "state": flow.state,
        "nonce": flow.nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    return f"{AUTHORITY}/{config.tenant_id}/oauth2/v2.0/authorize?{urlencode(params)}"


def exchange_code(config: EntraConfig, code: str, verifier: str) -> str:
    """The ID token for an authorization code. Microsoft's error text is logged, never shown."""
    try:
        response = httpx.post(config.token_url, timeout=TOKEN_TIMEOUT_SECONDS, data={
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirect_uri,
            "code_verifier": verifier,
            "scope": SCOPE,
        })
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise EntraError("failed", f"token request failed: {exc}") from exc
    if response.status_code != 200 or not isinstance(body, dict) or not body.get("id_token"):
        err = body.get("error") if isinstance(body, dict) else None
        desc = body.get("error_description") if isinstance(body, dict) else None
        raise EntraError("failed", f"token endpoint answered {response.status_code}: {err} {desc}")
    return str(body["id_token"])


def id_token_claims(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise EntraError("failed", "id_token is not a JWT")
    try:
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except (ValueError, json.JSONDecodeError) as exc:
        raise EntraError("failed", "id_token payload is unreadable") from exc
    if not isinstance(claims, dict):
        raise EntraError("failed", "id_token payload is not an object")
    return claims


def verified_email(config: EntraConfig, claims: Mapping[str, Any], nonce: str, now: float | None = None) -> str:
    """The signed-in person's work email, lower-cased, once the token is shown to be for this app,
    this tenant and this sign-in."""
    now = time.time() if now is None else now
    aud = claims.get("aud")
    if claims.get("iss") != config.issuer:
        raise EntraError("failed", f"unexpected issuer {claims.get('iss')!r}")
    if aud != config.client_id and not (isinstance(aud, list) and config.client_id in aud):
        raise EntraError("failed", "token is for another application")
    if str(claims.get("tid") or "").lower() != config.tenant_id.lower():
        raise EntraError("failed", "token is from another tenant")
    try:
        expires = float(claims.get("exp"))  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise EntraError("failed", "token has no expiry") from exc
    if expires + CLOCK_SKEW_SECONDS < now:
        raise EntraError("expired", "token has expired")
    if not nonce or claims.get("nonce") != nonce:
        raise EntraError("failed", "nonce does not match this sign-in")
    email = claims.get("preferred_username") or claims.get("email")
    if not isinstance(email, str) or "@" not in email:
        raise EntraError("failed", "token carries no email")
    return email.strip().lower()
