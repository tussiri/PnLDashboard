"""Per-user permissions: what a signed-in user may open and see, beyond the role and account scope.

A role (app/auth.py) is a preset: each permission has a default per role. A user may carry
overrides (ops.app_user.permissions, migration 042; or "permissions" on an APP_USERS_JSON entry)
that switch single permissions on or off. Administrators always hold every permission. The catalog
below is mirrored by the browser (src/auth/permissions.ts), which hides what a user may not open;
the API enforces the same keys on its routes (require_permission) and strips the fields a user may
not see (strip).

Keys
    view.company        the Company page (every account; also needs an unlimited account scope)
    view.analytics      the Portfolio pages (route #/portfolio; the key keeps its first name)
    tab.<account tab>   an account tab (sites, pallet, over-target, overtime, income-statement,
                        subcontracted, map, vendors, feedback, budget); Overview is always open
    data.allocations    corporate allocations and margin after allocations
    data.month          the month-end rollup (the Week / Month switch)
    data.staffing       staffing requests on the site drawer
    data.invoices       vendor invoices on the site drawer
    data.photos         CompanyCam photos on the site drawer
    data.export         CSV downloads
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from fastapi import HTTPException, Request

from .auth import ROLES, User

#: (key, group, label). Order is the matrix column order.
CATALOG: tuple[tuple[str, str, str], ...] = (
    ("view.company", "Views", "Company"),
    ("view.analytics", "Views", "Portfolio"),
    ("tab.sites", "Account tabs", "Sites"),
    ("tab.pallet", "Account tabs", "Pallet"),
    ("tab.over-target", "Account tabs", "Hours to cut"),
    ("tab.overtime", "Account tabs", "Overtime"),
    ("tab.income-statement", "Account tabs", "Income statement"),
    ("tab.subcontracted", "Account tabs", "Subcontracted"),
    ("tab.map", "Account tabs", "Map"),
    ("tab.vendors", "Account tabs", "Vendors"),
    ("tab.feedback", "Account tabs", "Feedback"),
    ("tab.budget", "Account tabs", "Budget"),
    ("data.allocations", "Data", "Allocations and margin"),
    ("data.month", "Data", "Month rollup"),
    ("data.staffing", "Data", "Staffing requests"),
    ("data.invoices", "Data", "Vendor invoices"),
    ("data.photos", "Data", "Photos"),
    ("data.export", "Data", "CSV export"),
)
KEYS: tuple[str, ...] = tuple(k for k, _, _ in CATALOG)

_EXECUTIVE_OFF = frozenset({"view.analytics", "data.staffing"})
_ANALYST_OFF = frozenset({"view.analytics"})
ROLE_DEFAULTS: dict[str, dict[str, bool]] = {
    "executive": {k: k not in _EXECUTIVE_OFF for k in KEYS},
    "analyst": {k: k not in _ANALYST_OFF for k in KEYS},
    "admin": {k: True for k in KEYS},
}
assert set(ROLE_DEFAULTS) == set(ROLES)

ALLOCATION_FIELDS = ("alloc_management", "alloc_burden", "alloc_overhead")


def validate(value: Any) -> dict[str, bool]:
    """Overrides as {key: bool}; ValueError for an unknown key or a non-boolean."""
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError("permissions must be an object of {key: true|false}")
    unknown = sorted(str(k) for k in value if k not in KEYS)
    if unknown:
        raise ValueError(f"Unknown permission(s): {', '.join(unknown)}")
    bad = sorted(str(k) for k, v in value.items() if not isinstance(v, bool))
    if bad:
        raise ValueError(f"Permission(s) must be true or false: {', '.join(bad)}")
    return {str(k): bool(v) for k, v in value.items()}


def overrides_of(role: str, effective_: Mapping[str, bool]) -> dict[str, bool]:
    """The overrides that turn the role's defaults into `effective_` (what the matrix stores)."""
    defaults = ROLE_DEFAULTS.get(role, ROLE_DEFAULTS["executive"])
    return {k: bool(v) for k, v in effective_.items() if k in KEYS and bool(v) != defaults[k]}


def effective(role: str, overrides: Mapping[str, Any] | None) -> dict[str, bool]:
    """Every key, from the role's defaults with the user's overrides applied. Administrators hold all."""
    if role == "admin":
        return dict(ROLE_DEFAULTS["admin"])
    out = dict(ROLE_DEFAULTS.get(role, ROLE_DEFAULTS["executive"]))
    for k, v in (overrides or {}).items():
        if k in out:
            out[k] = bool(v)
    return out


def allowed(user: User | None, key: str) -> bool:
    """None (the admin token, or no session on a public route) holds every permission."""
    if key not in KEYS:
        raise ValueError(f"unknown permission {key}")
    return True if user is None else effective(user.role, user.permissions)[key]


def require_permission(key: str) -> Callable[[Request], None]:
    """Route dependency: 403 unless the signed-in user holds `key` (the admin token passes)."""
    if key not in KEYS:
        raise ValueError(f"unknown permission {key}")

    def dependency(request: Request) -> None:
        from .common import current_user

        if not allowed(current_user(request), key):
            raise HTTPException(status_code=403, detail=f"Your access does not include {label(key).lower()}")

    return dependency


def label(key: str) -> str:
    return next(lbl for k, _, lbl in CATALOG if k == key)


def strip(user: User | None, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop the allocation fields from job rows for a user without data.allocations."""
    if allowed(user, "data.allocations"):
        return rows
    for r in rows:
        for f in ALLOCATION_FIELDS:
            r.pop(f, None)
    return rows


def catalog() -> dict[str, Any]:
    return {"permissions": [{"key": k, "group": g, "label": lbl} for k, g, lbl in CATALOG], "defaults": ROLE_DEFAULTS}
