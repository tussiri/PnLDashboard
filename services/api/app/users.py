"""Sign-in users kept in the database (ops.app_user, migration 035), managed in Admin > Users.

They sit beside the environment-defined users of APP_USERS_JSON (app/auth.py), which win on a name
clash and stay as a way back in. The first administrator is created on the one-time setup page
(APP_SETUP_TOKEN), which closes as soon as any database or environment user exists.

A session cookie names a user and carries its role, but a database user is re-read (cached for
CACHE_SECONDS) on every request: a disabled account or a changed role takes effect within that
window, and a password reset refuses every session issued before it (sessions_valid_after).
"""
from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from . import permissions
from psycopg.types.json import Jsonb

from .auth import _DUMMY_HASH, ROLES, User, hash_password, verify_password

logger = logging.getLogger(__name__)

USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._@-]{2,100}$")
MIN_PASSWORD_LENGTH = 10
CACHE_SECONDS = 30.0
CLOCK_SKEW_SECONDS = 2.0


class UserError(ValueError):
    """A request the user store refuses; `status` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class StoredUser:
    username: str
    role: str
    password_hash: str
    active: bool
    sessions_valid_after: datetime
    created_at: datetime | None = None
    created_by: str | None = None
    last_login_at: datetime | None = None
    #: Accounts the user may see; None = every account.
    account_slugs: list[str] | None = None
    #: Permission overrides over the role's defaults (app/permissions.py); None = the defaults.
    permissions: dict[str, bool] | None = None

    def public(self) -> dict[str, Any]:
        return {"username": self.username, "role": self.role, "active": self.active, "source": "database", "accounts": self.account_slugs,
                "permissions": self.permissions or {}, "effective_permissions": permissions.effective(self.role, self.permissions),
                "created_at": _iso(self.created_at), "created_by": self.created_by, "last_login_at": _iso(self.last_login_at)}

    @property
    def accounts(self) -> tuple[str, ...] | None:
        return tuple(self.account_slugs) if self.account_slugs else None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def validate_username(username: str) -> str:
    name = (username or "").strip()
    if not USERNAME_PATTERN.match(name):
        raise UserError("Usernames are 2 to 100 letters, digits, dots, dashes, underscores or @")
    return name


def validate_role(role: str) -> str:
    value = (role or "").strip().lower()
    if value not in ROLES:
        raise UserError(f"Role must be one of {', '.join(ROLES)}")
    return value


def validate_password(password: str) -> str:
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise UserError(f"Passwords need at least {MIN_PASSWORD_LENGTH} characters")
    return password


class UserStore(Protocol):
    def get(self, username: str) -> StoredUser | None: ...
    def all(self) -> list[StoredUser]: ...
    def create(self, user: StoredUser, *, only_if_empty: bool = False) -> bool: ...
    def update(self, username: str, changes: dict[str, Any], actor: str) -> StoredUser | None: ...
    def touch_login(self, username: str) -> None: ...


class PostgresUserStore:
    COLUMNS = "username, role, password_hash, active, sessions_valid_after, created_at, created_by, last_login_at, account_slugs, permissions"

    def _row(self, row: dict[str, Any] | None) -> StoredUser | None:
        return StoredUser(**row) if row else None

    def get(self, username: str) -> StoredUser | None:
        from .db import connection
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute(f"SELECT {self.COLUMNS} FROM ops.app_user WHERE lower(username) = lower(%s)", (username,))
            return self._row(cursor.fetchone())

    def all(self) -> list[StoredUser]:
        from .db import connection
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute(f"SELECT {self.COLUMNS} FROM ops.app_user ORDER BY lower(username)")
            return [StoredUser(**r) for r in cursor.fetchall()]

    def create(self, user: StoredUser, *, only_if_empty: bool = False) -> bool:
        """Insert; False when the name is taken or (only_if_empty) any user already exists."""
        from .db import connection
        with connection() as conn, conn.cursor() as cursor:
            if only_if_empty:
                # Two setup requests racing must not both create an administrator.
                cursor.execute("LOCK TABLE ops.app_user IN SHARE ROW EXCLUSIVE MODE")
                cursor.execute("SELECT EXISTS (SELECT 1 FROM ops.app_user) AS taken")
                if cursor.fetchone()["taken"]:
                    return False
            cursor.execute(
                """
                INSERT INTO ops.app_user (username, role, password_hash, active, created_by, updated_by, account_slugs, permissions)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (user.username, user.role, user.password_hash, user.active, user.created_by, user.created_by, user.account_slugs,
                 Jsonb(user.permissions) if user.permissions else None),
            )
            created = cursor.rowcount == 1
            conn.commit()
            return created

    def update(self, username: str, changes: dict[str, Any], actor: str) -> StoredUser | None:
        from psycopg import sql

        from .db import connection
        if changes.get("permissions") is not None:
            changes = {**changes, "permissions": Jsonb(changes["permissions"])}
        sets = [sql.SQL("{} = %s").format(sql.Identifier(k)) for k in changes]
        if "password_hash" in changes:
            sets.append(sql.SQL("sessions_valid_after = date_trunc('second', now())"))
        sets += [sql.SQL("updated_at = now()"), sql.SQL("updated_by = %s")]
        query = sql.SQL("UPDATE ops.app_user SET {} WHERE lower(username) = lower(%s) RETURNING " + self.COLUMNS).format(sql.SQL(", ").join(sets))
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute(query, (*changes.values(), actor, username))
            row = cursor.fetchone()
            conn.commit()
            return self._row(row)

    def touch_login(self, username: str) -> None:
        from .db import connection
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute("UPDATE ops.app_user SET last_login_at = now() WHERE lower(username) = lower(%s)", (username,))
            conn.commit()


_store: UserStore = PostgresUserStore()
_cache: dict[str, tuple[float, StoredUser | None]] = {}
_lock = threading.Lock()


def set_store(store: UserStore) -> None:
    """Replace the store (tests)."""
    global _store
    _store = store
    clear_cache()


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def lookup(username: str) -> StoredUser | None:
    """The database user, cached for CACHE_SECONDS. A database error reads as no user."""
    key = (username or "").lower()
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        user = _store.get(username)
    except Exception:  # noqa: BLE001 - an unreachable database must sign database users out, not crash
        logger.exception("Could not read user %s", username)
        return None
    with _lock:
        _cache[key] = (now, user)
    return user


def authenticate(username: str, password: str) -> User | None:
    """An active database user for valid credentials, else None (an unknown name still pays for a hash)."""
    record = lookup((username or "").strip()) if username else None
    if record is None or not record.active:
        verify_password(password or "x", _DUMMY_HASH)
        return None
    if not verify_password(password, record.password_hash):
        return None
    try:
        _store.touch_login(record.username)
    except Exception:  # noqa: BLE001 - a failed timestamp must not refuse a valid sign-in
        logger.exception("Could not record sign-in for %s", record.username)
    return User(record.username, record.role, record.accounts, record.permissions)


def session_user(user: User, issued_at: float) -> User | None:
    """The database user behind a verified cookie: None when unknown, disabled or reset since."""
    record = lookup(user.username)
    if record is None or not record.active:
        return None
    # Cookies carry whole seconds; allow a little clock skew between the API and the database.
    if issued_at + CLOCK_SKEW_SECONDS < record.sessions_valid_after.timestamp():
        return None
    return User(record.username, record.role, record.accounts, record.permissions)


def any_users() -> bool:
    return bool(_store.all())


def listing() -> list[dict[str, Any]]:
    return [u.public() for u in _store.all()]


def normalize_accounts(accounts: list[str] | None, known: set[str] | None = None) -> list[str] | None:
    """Account slugs, de-duplicated and checked against `known`; an empty list means every account."""
    if not accounts:
        return None
    slugs = sorted({a.strip() for a in accounts if a and a.strip()})
    unknown = [a for a in slugs if known is not None and a not in known]
    if unknown:
        raise UserError(f"Unknown account(s): {', '.join(unknown)}")
    return slugs or None


def validate_permissions(value: Any) -> dict[str, bool] | None:
    try:
        return permissions.validate(value) or None
    except ValueError as exc:
        raise UserError(str(exc)) from exc


def create(username: str, role: str, password: str, actor: str, *, only_if_empty: bool = False,
           accounts: list[str] | None = None, permissions_: Any = None) -> StoredUser:
    user = StoredUser(validate_username(username), validate_role(role), hash_password(validate_password(password)), True,
                      datetime.now(timezone.utc), created_by=actor, account_slugs=accounts or None, permissions=validate_permissions(permissions_))
    if not _store.create(user, only_if_empty=only_if_empty):
        raise UserError("Setup is already complete" if only_if_empty else f"{user.username} already exists", status=409)
    clear_cache()
    return _store.get(user.username) or user


UNCHANGED: Any = object()


def update(username: str, actor: str, *, role: str | None = None, active: bool | None = None, password: str | None = None,
           environment_admins: int = 0, accounts: Any = UNCHANGED, permissions_: Any = UNCHANGED) -> StoredUser:
    """Change a database user's role, active flag, password, accounts or permission overrides. Refuses to
    leave no active administrator (environment administrators from APP_USERS_JSON count)."""
    current = _store.get(username)
    if current is None:
        raise UserError(f"{username} does not exist", status=404)
    changes: dict[str, Any] = {}
    if role is not None:
        changes["role"] = validate_role(role)
    if active is not None:
        changes["active"] = bool(active)
    if password is not None:
        changes["password_hash"] = hash_password(validate_password(password))
    if accounts is not UNCHANGED:
        changes["account_slugs"] = accounts or None
    if permissions_ is not UNCHANGED:
        changes["permissions"] = validate_permissions(permissions_)
    if not changes:
        return current
    still_admin = changes.get("role", current.role) == "admin" and changes.get("active", current.active)
    if current.role == "admin" and current.active and not still_admin:
        others = sum(1 for u in _store.all() if u.role == "admin" and u.active and u.username.lower() != current.username.lower())
        if others + environment_admins == 0:
            raise UserError("At least one active administrator is required", status=409)
    updated = _store.update(current.username, changes, actor)
    clear_cache()
    if updated is None:
        raise UserError(f"{username} does not exist", status=404)
    return updated
