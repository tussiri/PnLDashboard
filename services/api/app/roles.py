"""Roles: named permission presets, built in or made in Admin > Users > Roles (migration 054).

A role is a name and a {permission key: on/off} set over app/permissions.py's catalog. A user holds
one role (ops.app_user.role is its slug) plus optional per-user overrides on top.

Built in
    admin       Administrator: every permission, the Admin pages, every account. Fixed.
    none        No access: nothing at all. The role a first Microsoft sign-in lands with until an
                administrator picks a real one. Fixed.
    executive   Editable presets (a row in ops.app_role records the edits; a key the row lacks keeps
    analyst     the default below). They cannot be deleted.

Custom roles are rows with any other slug; a key their row lacks is off. A role still held by a user
cannot be deleted. Rows are cached for CACHE_SECONDS, so an edit reaches sessions already signed in
within that window (the same as a user's role change).
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from . import permissions

logger = logging.getLogger(__name__)

ADMIN = "admin"
NONE = "none"
PRESETS: tuple[str, ...] = ("executive", "analyst")
FIXED: tuple[str, ...] = (ADMIN, NONE)
BUILT_IN: tuple[str, ...] = (*PRESETS, ADMIN, NONE)
BUILT_IN_NAMES = {"executive": "Executive", "analyst": "Analyst", ADMIN: "Administrator", NONE: "No access"}
SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
CACHE_SECONDS = 30.0


class RoleError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Role:
    slug: str
    name: str
    #: Every catalog key, on or off.
    permissions: dict[str, bool]
    built_in: bool

    @property
    def editable(self) -> bool:
        return self.slug not in FIXED

    @property
    def deletable(self) -> bool:
        return not self.built_in

    def public(self, users: int = 0) -> dict[str, Any]:
        return {"slug": self.slug, "name": self.name, "permissions": self.permissions, "built_in": self.built_in,
                "editable": self.editable, "deletable": self.deletable and users == 0, "users": users}


class RoleStore(Protocol):
    def all(self) -> list[dict[str, Any]]: ...
    def upsert(self, slug: str, name: str, permissions_: dict[str, bool], actor: str, *, create_only: bool) -> bool: ...
    def delete(self, slug: str) -> bool: ...


class PostgresRoleStore:
    def all(self) -> list[dict[str, Any]]:
        from .db import connection
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute("SELECT slug, name, permissions FROM ops.app_role ORDER BY lower(name)")
            return list(cursor.fetchall())

    def upsert(self, slug: str, name: str, permissions_: dict[str, bool], actor: str, *, create_only: bool) -> bool:
        """Insert (create_only: False when the slug or name is taken) or insert-or-replace."""
        from psycopg import errors
        from psycopg.types.json import Jsonb

        from .db import connection
        conflict = "DO NOTHING" if create_only else (
            "(slug) DO UPDATE SET name = EXCLUDED.name, permissions = EXCLUDED.permissions, updated_at = now(), updated_by = EXCLUDED.updated_by")
        with connection() as conn, conn.cursor() as cursor:
            try:
                cursor.execute(
                    f"INSERT INTO ops.app_role (slug, name, permissions, created_by, updated_by) VALUES (%s, %s, %s, %s, %s) ON CONFLICT {conflict}",
                    (slug, name, Jsonb(permissions_), actor, actor))
            except errors.UniqueViolation:
                conn.rollback()
                return False
            done = cursor.rowcount == 1
            conn.commit()
            return done

    def delete(self, slug: str) -> bool:
        from .db import connection
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute("DELETE FROM ops.app_role WHERE slug = %s", (slug,))
            done = cursor.rowcount == 1
            conn.commit()
            return done


_store: RoleStore = PostgresRoleStore()
_cache: tuple[float, dict[str, Role]] | None = None
_lock = threading.Lock()


def set_store(store: RoleStore) -> None:
    """Replace the store (tests)."""
    global _store
    _store = store
    clear_cache()


def clear_cache() -> None:
    global _cache
    with _lock:
        _cache = None


def _complete(values: Mapping[str, Any] | None, base: Mapping[str, bool]) -> dict[str, bool]:
    out = dict(base)
    for k, v in (values or {}).items():
        if k in out:
            out[k] = bool(v)
    return out


def _built_in(stored: dict[str, dict[str, Any]]) -> dict[str, Role]:
    out = {ADMIN: Role(ADMIN, BUILT_IN_NAMES[ADMIN], {k: True for k in permissions.KEYS}, True),
           NONE: Role(NONE, BUILT_IN_NAMES[NONE], {k: False for k in permissions.KEYS}, True)}
    for slug in PRESETS:
        row = stored.get(slug)
        out[slug] = Role(slug, (row or {}).get("name") or BUILT_IN_NAMES[slug],
                         _complete((row or {}).get("permissions"), permissions.ROLE_DEFAULTS[slug]), True)
    return out


def _load() -> dict[str, Role]:
    try:
        rows = {r["slug"]: r for r in _store.all()}
    except Exception:  # noqa: BLE001 - no database (tests, a cold start): the built-in roles still work
        logger.exception("Could not read roles; using the built-in roles only")
        rows = {}
    out = _built_in(rows)
    off = {k: False for k in permissions.KEYS}
    for slug, row in rows.items():
        if slug not in out:
            out[slug] = Role(slug, row["name"], _complete(row.get("permissions"), off), False)
    return out


def _all() -> dict[str, Role]:
    global _cache
    now = time.monotonic()
    with _lock:
        if _cache and now - _cache[0] < CACHE_SECONDS:
            return _cache[1]
    loaded = _load()
    with _lock:
        _cache = (now, loaded)
    return loaded


def listing() -> list[Role]:
    """Administrator first, then the presets and custom roles by name, No access last."""
    roles = _all()
    rest = sorted((r for s, r in roles.items() if s not in FIXED), key=lambda r: r.name.lower())
    return [roles[ADMIN], *rest, roles[NONE]]


def get(slug: str | None) -> Role | None:
    return _all().get((slug or "").strip().lower())


def exists(slug: str | None) -> bool:
    return get(slug) is not None


def defaults(slug: str | None) -> dict[str, bool]:
    """The role's permission set; an unknown slug (a role deleted under a stale session) holds nothing."""
    role = get(slug)
    return dict(role.permissions) if role else {k: False for k in permissions.KEYS}


def name(slug: str | None) -> str:
    role = get(slug)
    return role.name if role else str(slug or "")


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40].strip("-")
    return slug


def _validate_name(value: str, *, taken_by_other: bool) -> str:
    clean = " ".join((value or "").split())
    if not 2 <= len(clean) <= 60:
        raise RoleError("Role names are 2 to 60 characters")
    if taken_by_other:
        raise RoleError(f"A role named {clean} already exists", status=409)
    return clean


def _validate_permissions(value: Any) -> dict[str, bool]:
    try:
        return permissions.validate(value)
    except ValueError as exc:
        raise RoleError(str(exc)) from exc


def _name_taken(clean: str, except_slug: str | None = None) -> bool:
    return any(r.name.lower() == clean.lower() and r.slug != except_slug for r in _all().values())


def create(name_: str, permissions_: Any, actor: str, copy_from: str | None = None) -> Role:
    """A new custom role. Its permissions start from `copy_from` (a role's slug) or all off, with
    `permissions_` applied over them."""
    clean = _validate_name(name_, taken_by_other=False)
    if _name_taken(clean):
        raise RoleError(f"A role named {clean} already exists", status=409)
    slug = slugify(clean)
    if not SLUG_PATTERN.match(slug) or slug in BUILT_IN:
        raise RoleError("Pick a name with at least two letters or digits that is not a built-in role's")
    if slug in _all():
        raise RoleError(f"A role named like {clean} already exists", status=409)
    if copy_from and not exists(copy_from):
        raise RoleError(f"No role {copy_from} to copy", status=404)
    base = defaults(copy_from) if copy_from else {k: False for k in permissions.KEYS}
    values = _complete(_validate_permissions(permissions_), base)
    if not _store.upsert(slug, clean, values, actor, create_only=True):
        raise RoleError(f"A role named {clean} already exists", status=409)
    clear_cache()
    return get(slug)  # type: ignore[return-value]


def update(slug: str, actor: str, *, name_: str | None = None, permissions_: Any = None) -> Role:
    """Rename a role or replace its permissions (a partial set changes only the keys it names).
    Administrator and No access are fixed."""
    role = get(slug)
    if role is None:
        raise RoleError(f"No role {slug}", status=404)
    if not role.editable:
        raise RoleError(f"{role.name} is fixed", status=409)
    clean = role.name if name_ is None else _validate_name(name_, taken_by_other=False)
    if _name_taken(clean, except_slug=role.slug):
        raise RoleError(f"A role named {clean} already exists", status=409)
    values = _complete(_validate_permissions(permissions_), role.permissions) if permissions_ is not None else role.permissions
    _store.upsert(role.slug, clean, values, actor, create_only=False)
    clear_cache()
    return get(role.slug)  # type: ignore[return-value]


def reset(slug: str, actor: str) -> Role:
    """A built-in preset back to its shipped name and permissions."""
    if slug not in PRESETS:
        raise RoleError("Only Executive and Analyst have defaults to return to", status=409)
    _store.delete(slug)
    clear_cache()
    return get(slug)  # type: ignore[return-value]


def delete(slug: str, users_holding: int) -> None:
    role = get(slug)
    if role is None:
        raise RoleError(f"No role {slug}", status=404)
    if role.built_in:
        raise RoleError(f"{role.name} is built in and cannot be deleted", status=409)
    if users_holding:
        raise RoleError(f"{users_holding} user(s) still hold {role.name}; give them another role first", status=409)
    _store.delete(role.slug)
    clear_cache()
