"""Users, roles and signed session cookies (standard library only).

Roles
    executive  sees only the Executive Overview
    analyst    every view except Administration
    admin      everything

Users come from APP_USERS_JSON: a JSON list of {"username", "role", "password_hash"} where the
hash is ``pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>`` (generate one with
``python -m app.auth hash '<password>'``). APP_SESSION_SECRET is the HMAC key for session cookies.

APP_AUTH_MODE
    dev        adds three fixed development users (executive / analyst / admin, password
               ``dev-<username>``) and falls back to a fixed development session secret.
    required   refuses to start unless APP_USERS_JSON and APP_SESSION_SECRET are set.
    unset      ``required`` when either variable is present, otherwise ``dev`` (logged).

A session is ``base64url(username|role|expiry) . hex(HMAC-SHA256(secret, payload))`` valid for
twelve hours. Comparisons use hmac.compare_digest. Hashes are never logged or returned.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import os
import secrets
import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass

from .config import ConfigurationError

log = logging.getLogger(__name__)

ROLES: tuple[str, ...] = ("executive", "analyst", "admin")
ROLE_LABEL = {"executive": "Executive", "analyst": "Analyst", "admin": "Administrator"}
COOKIE_NAME = "crane_session"
SESSION_TTL_SECONDS = 12 * 60 * 60
HASH_SCHEME = "pbkdf2_sha256"
DEFAULT_ITERATIONS = 600_000
MODES: tuple[str, ...] = ("dev", "required")
DEV_USERNAMES: tuple[str, ...] = ROLES
DEV_PASSWORD_PREFIX = "dev-"
_DEV_SESSION_SECRET = "crane-ifs-development-session-secret-not-for-production"


@dataclass(frozen=True)
class User:
    username: str
    role: str

    def as_dict(self) -> dict[str, str]:
        return {"username": self.username, "role": self.role}


@dataclass(frozen=True)
class UserRecord:
    username: str
    role: str
    password_hash: str


# ── password hashing ─────────────────────────────────────────────────────────
def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def hash_password(password: str, iterations: int = DEFAULT_ITERATIONS, salt: bytes | None = None) -> str:
    """PBKDF2-HMAC-SHA256 hash in the ``pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>`` form."""
    if not password:
        raise ValueError("password must not be empty")
    if iterations < 1:
        raise ValueError("iterations must be positive")
    salt = salt if salt is not None else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{HASH_SCHEME}${iterations}${_b64(salt)}${_b64(digest)}"


def parse_hash(encoded: str) -> tuple[int, bytes, bytes] | None:
    """(iterations, salt, digest) for a well-formed hash, else None."""
    parts = (encoded or "").split("$")
    if len(parts) != 4 or parts[0] != HASH_SCHEME:
        return None
    try:
        iterations = int(parts[1])
        salt = base64.b64decode(parts[2], validate=True)
        digest = base64.b64decode(parts[3], validate=True)
    except (ValueError, binascii.Error):
        return None
    if iterations < 1 or not salt or not digest:
        return None
    return iterations, salt, digest


def verify_password(password: str, encoded: str) -> bool:
    """Constant-time check of ``password`` against a stored hash. Malformed hashes never verify."""
    parsed = parse_hash(encoded)
    if parsed is None or not password:
        return False
    iterations, salt, digest = parsed
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, digest)


# ── users ────────────────────────────────────────────────────────────────────
def parse_users_json(raw: str) -> dict[str, UserRecord]:
    """Validate APP_USERS_JSON into a username -> record map (usernames are case-sensitive, unique)."""
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigurationError("APP_USERS_JSON is not valid JSON") from exc
    if not isinstance(value, list):
        raise ConfigurationError("APP_USERS_JSON must be a JSON list of user objects")
    users: dict[str, UserRecord] = {}
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ConfigurationError(f"APP_USERS_JSON[{index}] must be an object")
        username = str(item.get("username") or "").strip()
        role = str(item.get("role") or "").strip().lower()
        password_hash = str(item.get("password_hash") or "").strip()
        if not username:
            raise ConfigurationError(f"APP_USERS_JSON[{index}] is missing a username")
        if role not in ROLES:
            raise ConfigurationError(f"APP_USERS_JSON[{index}] ({username}): role must be one of {', '.join(ROLES)}")
        if parse_hash(password_hash) is None:
            raise ConfigurationError(f"APP_USERS_JSON[{index}] ({username}): password_hash must be pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>")
        if username in users:
            raise ConfigurationError(f"APP_USERS_JSON lists {username} more than once")
        users[username] = UserRecord(username, role, password_hash)
    return users


def dev_users() -> dict[str, UserRecord]:
    """The three fixed development accounts (password ``dev-<username>``)."""
    return {name: UserRecord(name, name, hash_password(f"{DEV_PASSWORD_PREFIX}{name}", iterations=10_000, salt=b"crane-ifs-dev-salt")) for name in DEV_USERNAMES}


# ── session cookie ───────────────────────────────────────────────────────────
def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes | None:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (ValueError, binascii.Error):
        return None


def _signature(payload: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def sign_session(user: User, secret: str, now: float | None = None, ttl_seconds: int = SESSION_TTL_SECONDS) -> str:
    """Signed cookie value for ``user`` expiring ``ttl_seconds`` from ``now``."""
    if not secret:
        raise ValueError("a session secret is required")
    expiry = int((time.time() if now is None else now) + ttl_seconds)
    payload = f"{user.username}|{user.role}|{expiry}".encode("utf-8")
    return f"{_b64url(payload)}.{_signature(payload, secret)}"


def verify_session(token: str | None, secret: str, now: float | None = None) -> User | None:
    """The user behind a cookie value, or None when it is missing, tampered with, malformed or expired."""
    if not token or not secret or "." not in token:
        return None
    encoded, _, signature = token.rpartition(".")
    payload = _b64url_decode(encoded)
    if payload is None or not hmac.compare_digest(signature, _signature(payload, secret)):
        return None
    try:
        username, role, expiry_text = payload.decode("utf-8").split("|")
        expiry = int(expiry_text)
    except (UnicodeDecodeError, ValueError):
        return None
    if role not in ROLES or not username:
        return None
    if expiry <= (time.time() if now is None else now):
        return None
    return User(username, role)


# ── settings ─────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class AuthSettings:
    mode: str
    session_secret: str
    users: dict[str, UserRecord]

    @property
    def dev_mode(self) -> bool:
        return self.mode == "dev"

    @classmethod
    def load(cls, env: Mapping[str, str] | None = None) -> "AuthSettings":
        env = os.environ if env is None else env
        mode = (env.get("APP_AUTH_MODE") or "").strip().lower()
        secret = (env.get("APP_SESSION_SECRET") or "").strip()
        users_raw = (env.get("APP_USERS_JSON") or "").strip()
        if not mode:
            mode = "required" if (secret or users_raw not in ("", "[]")) else "dev"
            log.warning("APP_AUTH_MODE is not set; using %s mode", mode)
        if mode not in MODES:
            raise ConfigurationError(f"APP_AUTH_MODE must be one of {', '.join(MODES)}, got {mode!r}")
        users = parse_users_json(users_raw)
        if mode == "required":
            if not users:
                raise ConfigurationError("APP_AUTH_MODE=required needs APP_USERS_JSON with at least one user")
            if len(secret) < 32:
                raise ConfigurationError("APP_AUTH_MODE=required needs APP_SESSION_SECRET of at least 32 characters")
        else:
            secret = secret or _DEV_SESSION_SECRET
            merged = dev_users()
            merged.update(users)  # configured accounts win over the fixed development ones
            users = merged
        return cls(mode=mode, session_secret=secret, users=users)

    def authenticate(self, username: str, password: str) -> User | None:
        """User for valid credentials, else None. Unknown users still pay for one hash check."""
        record = self.users.get((username or "").strip())
        if record is None:
            verify_password(password or "x", _DUMMY_HASH)
            return None
        if not verify_password(password, record.password_hash):
            return None
        return User(record.username, record.role)

    def listing(self) -> list[dict[str, str]]:
        """Usernames and roles only (never hashes)."""
        return [{"username": u.username, "role": u.role, "source": "dev" if self.dev_mode and u.username in DEV_USERNAMES and u.password_hash == dev_users()[u.username].password_hash else "configured"} for u in self.users.values()]


_DUMMY_HASH = hash_password("dummy-password-for-timing", iterations=10_000, salt=b"crane-ifs-dummy-salt")
_settings: AuthSettings | None = None


def get_auth_settings() -> AuthSettings:
    """Lazily loaded, cached process-wide auth settings (raises ConfigurationError when invalid)."""
    global _settings
    if _settings is None:
        try:
            _settings = AuthSettings.load()
        except ConfigurationError as exc:
            raise ConfigurationError(f"Invalid environment: {exc}") from exc
    return _settings


def reset_auth_settings(settings: AuthSettings | None = None) -> None:
    """Replace (or clear) the cached settings; used by tests."""
    global _settings
    _settings = settings


# ── command line ─────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    usage = "usage: python -m app.auth hash '<password>' | python -m app.auth users"
    if not argv or argv[0] not in ("hash", "users"):
        print(usage, file=sys.stderr)
        return 2
    if argv[0] == "hash":
        if len(argv) != 2 or not argv[1]:
            print(usage, file=sys.stderr)
            return 2
        print(hash_password(argv[1]))
        return 0
    try:
        settings = get_auth_settings()
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"mode: {settings.mode}")
    for entry in settings.listing():
        print(f"{entry['username']}\t{entry['role']}\t{entry['source']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
