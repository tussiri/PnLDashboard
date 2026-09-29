"""Helpers shared by every router: period resolution, mart filters, settings, source disclosure."""
from __future__ import annotations

import hmac
import json
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from collections.abc import Callable

from fastapi import Header, HTTPException, Query, Request

from .auth import COOKIE_NAME, ROLE_LABEL, ROLES, User, get_auth_settings, session_claims
from .config import settings
from .db import connection

PERIODS = ("MTD", "QTD", "YTD", "T12M")
FILTER_COLUMNS = {
    "account": "parent_account",
    "region": "region",
    "branch": "branch",
    "service_type": "service_type",
    "vertical": "vertical",
    "job_number": "job_number",
    "company": "company",
}

PRIMARY_SOURCES = ("winteam_api", "finance_reference", "none")

# ── reporting scope (docs/api-contract.md, "Reporting scope: key accounts first") ─────────────
# The analysis views default to the key accounts and reach the long tail by drill-down.
SCOPE_KEY = "key"
SCOPE_ALL = "all"
SCOPE_OTHER = "other"
SCOPE_ACCOUNT = "account"          # echoed mode only: set implicitly when `account` is given
SCOPE_VALUES = (SCOPE_KEY, SCOPE_ALL, SCOPE_OTHER)
SCOPE_LABELS = {SCOPE_KEY: "Key accounts", SCOPE_ALL: "All accounts", SCOPE_OTHER: "Other accounts"}

DELIVERY_ALL = "all"
DELIVERY_SELF = "self_perform"
DELIVERY_SUB = "subcontracted"
DELIVERY_VALUES = (DELIVERY_ALL, DELIVERY_SELF, DELIVERY_SUB)

# The key accounts when the `key_accounts` setting is unset or malformed (seeded by migration 013).
DEFAULT_KEY_ACCOUNTS: list[dict[str, str]] = [
    {"name": "FedEx", "label": "FedEx (incl. FXE, FXG)"}, {"name": "Amazon", "label": "Amazon"},
    {"name": "Education", "label": "School districts"}, {"name": "Whole Foods", "label": "Whole Foods"},
    {"name": "Aldi", "label": "Aldi"},
]


def delivery_sql(alias: str | None = None) -> str:
    """The effective delivery model of a mart row: NULL delivery_model = self-performed when the row
    has hours, subcontracted otherwise.

    Both `mart.job_week` (executive view) and `mart.job_month` (reporting) carry `delivery_model`
    and `hours`, so the same expression is valid against either; pass the alias the query uses.
    """
    prefix = f"{alias}." if alias else ""
    return (f"coalesce({prefix}delivery_model, CASE WHEN {prefix}hours > 0 "
            f"THEN '{DELIVERY_SELF}' ELSE '{DELIVERY_SUB}' END)")


# unqualified form, for single-table queries over mart.job_week
DELIVERY_SQL = delivery_sql()


def key_accounts_setting(value: Any) -> list[dict[str, str]]:
    """Normalize the `key_accounts` setting to [{name, label}] in configured order (defaults when unset)."""
    out: list[dict[str, str]] = []
    for item in (value or []):
        if isinstance(item, str) and item.strip():
            out.append({"name": item.strip(), "label": item.strip()})
        elif isinstance(item, dict) and str(item.get("name") or "").strip():
            name = str(item["name"]).strip()
            out.append({"name": name, "label": str(item.get("label") or name).strip()})
    return out or list(DEFAULT_KEY_ACCOUNTS)


def configured_key_accounts() -> list[dict[str, str]]:
    """The `key_accounts` setting as [{name, label}] (one DB read)."""
    return key_accounts_setting(read_setting("key_accounts", None))


def key_account_names() -> tuple[str, ...]:
    return tuple(a["name"] for a in configured_key_accounts())


def parse_scope(value: str | None) -> str:
    """key | all | other (default key); anything else is a 422."""
    scope = (value or SCOPE_KEY).strip().lower()
    if scope not in SCOPE_VALUES:
        raise HTTPException(status_code=422, detail=f"scope must be one of {', '.join(SCOPE_VALUES)}")
    return scope


def parse_delivery(value: str | None) -> str:
    """all | self_perform | subcontracted (default all); anything else is a 422."""
    delivery = (value or DELIVERY_ALL).strip().lower()
    if delivery not in DELIVERY_VALUES:
        raise HTTPException(status_code=422, detail=f"delivery must be one of {', '.join(DELIVERY_VALUES)}")
    return delivery


def scope_clause(account: str | None, key_names: list[str] | tuple[str, ...], sub_account: str | None = None,
                 delivery: str = DELIVERY_ALL) -> tuple[str, list[Any]]:
    """Row filter for a single-table mart.job_week query (pure): account ("All" = the key accounts
    combined), optional sub_account, optional delivery.

    The executive weekly view's scope. `MartFilters.clause` is the aliased reporting twin; both
    build the key-account membership test and the delivery rule from the same helpers.
    """
    if account in (None, "", "All"):
        clause, params = " AND parent_account = ANY(%s::text[])", [list(key_names)]
    else:
        clause, params = " AND parent_account = %s", [account]
    if sub_account and sub_account.strip():
        clause += " AND sub_account = %s"
        params.append(sub_account.strip())
    if delivery != DELIVERY_ALL:
        clause += f" AND {DELIVERY_SQL} = %s"
        params.append(delivery)
    return clause, params


MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
ANY_ROLE_PATH_SUFFIXES = ("/system/status", "/dimensions")


def admin_token_valid(x_admin_token: str | None) -> bool:
    token = settings.ingestion_admin_token
    return bool(token and x_admin_token and hmac.compare_digest(x_admin_token, token))


def current_user(request: Request) -> User | None:
    """The signed-in user behind the session cookie, or None. An APP_USERS_JSON user keeps the role
    in the cookie; a database user is re-read (app/users.py), so disabling, a role change or a
    password reset applies to sessions already issued."""
    settings_ = get_auth_settings()
    claims = session_claims(request.cookies.get(COOKIE_NAME), settings_.session_secret)
    if claims is None:
        return None
    user, issued_at = claims
    record = settings_.users.get(user.username)
    if record is not None:
        return User(record.username, record.role)
    from . import users

    return users.session_user(user, issued_at)


def require_admin(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
    """Protected operations: a valid X-Admin-Token OR an admin-role session (either satisfies)."""
    if admin_token_valid(x_admin_token):
        return
    user = current_user(request)
    if user is not None and user.role == "admin":
        return
    raise HTTPException(status_code=401, detail="A valid ingestion admin token or an administrator sign-in is required")


def _roles_label(roles: tuple[str, ...]) -> str:
    return " or ".join(ROLE_LABEL.get(r, r) for r in roles)


def require_role(*roles: str) -> Callable[..., User | None]:
    """Router-level dependency: reads require a session whose role is in ``roles`` (no roles = any
    signed-in role); mutating requests accept a valid X-Admin-Token or an admin session instead, so
    scripted admin calls keep working without a browser session."""
    unknown = [r for r in roles if r not in ROLES]
    if unknown:
        raise ValueError(f"unknown role(s): {', '.join(unknown)}")
    allowed = tuple(roles) or ROLES

    def dependency(request: Request, x_admin_token: str | None = Header(default=None)) -> User | None:
        if request.method in MUTATING_METHODS:
            if admin_token_valid(x_admin_token):
                return None
            user = current_user(request)
            if user is None:
                raise HTTPException(status_code=401, detail="Sign in required")
            if user.role != "admin":
                raise HTTPException(status_code=403, detail="This action requires the Administrator role")
            return user
        user = current_user(request)
        if user is None:
            raise HTTPException(status_code=401, detail="Sign in required")
        if user.role not in allowed:
            raise HTTPException(status_code=403, detail=f"This view requires the {_roles_label(allowed)} role")
        return user

    return dependency


_analyst_or_admin = require_role("analyst", "admin")


def platform_access(request: Request, x_admin_token: str | None = Header(default=None)) -> User | None:
    """Platform router: /system/status and /dimensions for any signed-in role (the shell needs them);
    other reads for analysts and admins; writes per require_role (admin token or admin session)."""
    path = request.url.path
    if request.method not in MUTATING_METHODS and any(path.endswith(suffix) for suffix in ANY_ROLE_PATH_SUFFIXES):
        user = current_user(request)
        if user is None:
            raise HTTPException(status_code=401, detail="Sign in required")
        return user
    return _analyst_or_admin(request, x_admin_token)


# ── month arithmetic ─────────────────────────────────────────────────────────
def month_start(value: date) -> date:
    return value.replace(day=1)


def add_months(value: date, k: int) -> date:
    idx = value.year * 12 + (value.month - 1) + k
    return date(idx // 12, idx % 12 + 1, 1)


def month_end(value: date) -> date:
    return value.replace(day=monthrange(value.year, value.month)[1])


def parse_month(value: str | None) -> date | None:
    if not value:
        return None
    try:
        parsed = date.fromisoformat(value[:10])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="month must be an ISO date (YYYY-MM-01)") from exc
    return month_start(parsed)


@dataclass(frozen=True)
class MonthRange:
    period: str
    anchor: date
    start: date
    end: date

    @property
    def months(self) -> int:
        return (self.end.year - self.start.year) * 12 + self.end.month - self.start.month + 1

    def prior(self) -> "MonthRange":
        """The equivalent preceding range (prior month / prior QTD / prior YTD / prior 12)."""
        if self.period == "MTD":
            return MonthRange(self.period, add_months(self.anchor, -1), add_months(self.start, -1), add_months(self.end, -1))
        if self.period == "T12M":
            return MonthRange(self.period, add_months(self.anchor, -12), add_months(self.start, -12), add_months(self.end, -12))
        if self.period == "QTD":
            return MonthRange(self.period, add_months(self.anchor, -3), add_months(self.start, -3), add_months(self.end, -3))
        return MonthRange(self.period, add_months(self.anchor, -12), add_months(self.start, -12), add_months(self.end, -12))

    def as_dict(self) -> dict[str, Any]:
        return {"from": self.start.isoformat(), "to": self.end.isoformat(), "months": self.months, "period": self.period, "anchor": self.anchor.isoformat()}


def resolve_range(period: str, anchor: date) -> MonthRange:
    period = (period or "YTD").upper()
    if period not in PERIODS:
        raise HTTPException(status_code=422, detail=f"period must be one of {', '.join(PERIODS)}")
    anchor = month_start(anchor)
    if period == "MTD":
        start = anchor
    elif period == "QTD":
        start = date(anchor.year, ((anchor.month - 1) // 3) * 3 + 1, 1)
    elif period == "YTD":
        start = date(anchor.year, 1, 1)
    else:
        start = add_months(anchor, -11)
    return MonthRange(period, anchor, start, anchor)


def month_status_rows() -> list[dict[str, Any]]:
    """Every mart month with a truthful status: closed (invoiced and past the close lag),
    in_progress (the month has activity but is not yet closed), or no_revenue."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'close_lag_days'")
        row = cursor.fetchone()
        lag = int(row["value"]) if row and row["value"] is not None else 5
        cursor.execute("SELECT month, revenue, hours FROM mart.portfolio_month ORDER BY month")
        rows = cursor.fetchall()
    today = date.today()
    out: list[dict[str, Any]] = []
    for r in rows:
        month: date = r["month"]
        invoiced = float(r["revenue"] or 0) > 0
        closed = invoiced and (month_end(month) + timedelta(days=lag)) < today
        out.append({
            "month": month,
            "status": "closed" if closed else ("in_progress" if (invoiced or float(r["hours"] or 0) > 0) else "no_revenue"),
        })
    return out


def latest_mart_month() -> date | None:
    """Default reporting anchor: the latest CLOSED month (fully invoiced and past the close lag).

    The current month has labor but no invoices until several days after month end, so
    anchoring on it would silently understate revenue and margin. In-progress months stay
    selectable through the month picker and are labelled as such by /dimensions."""
    rows = month_status_rows()
    closed = [r["month"] for r in rows if r["status"] == "closed"]
    if closed:
        return closed[-1]
    active = [r["month"] for r in rows if r["status"] == "in_progress"]
    if active:
        return active[-1]
    return rows[-1]["month"] if rows else None


def resolve_request_range(period: str = Query("YTD"), month: str | None = Query(None)) -> MonthRange:
    """FastAPI dependency: resolve the requested period against the latest mart month."""
    anchor = parse_month(month) or latest_mart_month() or month_start(date.today())
    return resolve_range(period, anchor)


# ── filters ──────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class MartFilters:
    """Every reporting endpoint's filter set, including the key-account scope.

    Precedence: `account` wins over `scope`. With an account the query is that one account and
    `scope` contributes no SQL (the response echoes mode "account"); without one, `scope` selects
    the key accounts ("key", the default), everything but them ("other") or everything ("all").

    `key_accounts` are the names the "key"/"other" tests use. `resolve_filters` fills them from the
    `key_accounts` setting; left as None (hand-built filters, tests) the built-in
    DEFAULT_KEY_ACCOUNTS are used, so `clause()` stays pure and never emits an empty membership
    test that would silently return no rows.
    """

    account: str | None = None
    region: str | None = None
    branch: str | None = None
    service_type: str | None = None
    vertical: str | None = None
    job_number: str | None = None
    company: str | None = None
    scope: str = SCOPE_KEY
    sub_account: str | None = None
    delivery: str = DELIVERY_ALL
    key_accounts: tuple[str, ...] | None = None
    #: (name, label) of the configured key accounts, so `account_label` needs no DB read.
    key_account_labels: tuple[tuple[str, str], ...] | None = None

    # ── derived ──
    @property
    def scope_names(self) -> list[str]:
        """The key-account names the scope test compares against."""
        if self.key_accounts is not None:
            return list(self.key_accounts)
        return [a["name"] for a in DEFAULT_KEY_ACCOUNTS]

    @property
    def mode(self) -> str:
        """The echoed scope mode: "account" when an account is set, else the requested scope."""
        return SCOPE_ACCOUNT if self.account not in (None, "", "All") else self.scope

    @property
    def account_label(self) -> str:
        """The account's display label: the configured `key_accounts` label when it has one.

        The account group is stored under its WinTeam name (`Education`) but shown to the reader
        under the configured label (`School districts`), so the scope line and the account
        selector agree. Pure: the labels are resolved once in `resolve_filters`, and the built-in
        defaults answer when they were not.
        """
        account = str(self.account or "")
        pairs = self.key_account_labels
        if pairs is None:
            pairs = tuple((a["name"], a.get("label") or a["name"]) for a in DEFAULT_KEY_ACCOUNTS)
        for name, label in pairs:
            if name == account:
                return str(label or account)
        return account

    @property
    def label(self) -> str:
        """Human label of the scope, for `range.scope.label` and endpoint notes.

        A key account is named by its configured display label ("School districts" for the
        `Education` account group) so the label matches the account selector.
        """
        base = self.account_label if self.mode == SCOPE_ACCOUNT else SCOPE_LABELS.get(self.scope, self.scope)
        if self.sub_account:
            base = f"{base} / {self.sub_account}"
        if self.delivery != DELIVERY_ALL:
            base = f"{base} / {self.delivery} sites"
        return str(base)

    def clause(self, alias: str = "jm") -> tuple[str, list[Any]]:
        """SQL fragment (always starts with AND) and parameters for the active filters.

        Emitted in a fixed order: the exact-match dimension filters (FILTER_COLUMNS), then the
        scope, then sub_account, then delivery. Valid against `mart.job_month` (and any relation
        carrying the same columns); the delivery rule needs `delivery_model` and `hours`, which
        `mart.job_month` has, so it works there exactly as it does on `mart.job_week`.
        `sub_account` needs the column migration 018 added to `mart.job_month`.
        """
        parts: list[str] = []
        params: list[Any] = []
        for field, column in FILTER_COLUMNS.items():
            value = getattr(self, field)
            if value not in (None, "", "All"):
                parts.append(f" AND {alias}.{column} = %s")
                params.append(value)
        # An explicit account IS the scope; the key/other test only applies without one.
        if self.mode == SCOPE_KEY:
            parts.append(f" AND {alias}.parent_account = ANY(%s::text[])")
            params.append(self.scope_names)
        elif self.mode == SCOPE_OTHER:
            parts.append(f" AND (coalesce({alias}.parent_account, '') <> ALL(%s::text[]))")
            params.append(self.scope_names)
        if self.sub_account:
            parts.append(f" AND {alias}.sub_account = %s")
            params.append(self.sub_account)
        if self.delivery != DELIVERY_ALL:
            parts.append(f" AND {delivery_sql(alias)} = %s")
            params.append(self.delivery)
        return "".join(parts), params

    def active(self) -> dict[str, str]:
        """The filters actually narrowing the query, for a response's `filters` echo.

        Defaults are omitted: `delivery` only when it narrows, `scope` only when no account is set
        (an account is its own scope) and it is not "all" (which narrows nothing). `key_accounts`
        is configuration, not a filter, so it never appears.
        """
        skip = {"scope", "delivery", "key_accounts"}
        out = {k: v for k, v in self.__dict__.items() if k not in skip and v not in (None, "", "All")}
        if self.mode in (SCOPE_KEY, SCOPE_OTHER):
            out["scope"] = self.scope
        if self.delivery != DELIVERY_ALL:
            out["delivery"] = self.delivery
        return out


def resolve_filters(
    account: str | None = Query(None),
    region: str | None = Query(None),
    branch: str | None = Query(None),
    service_type: str | None = Query(None),
    vertical: str | None = Query(None),
    job_number: str | None = Query(None),
    company: str | None = Query(None),
    scope: str | None = Query(None),
    sub_account: str | None = Query(None),
    delivery: str | None = Query(None),
) -> MartFilters:
    """FastAPI dependency: the request's filters plus the key-account scope.

    422 on an unknown `scope` or `delivery`, and on `sub_account` without `account` (a sub-account
    label is only unique under its parent account).
    """
    scope_value = parse_scope(scope)
    delivery_value = parse_delivery(delivery)
    sub = (sub_account or "").strip() or None
    if sub and (account or "").strip() in ("", "All"):
        raise HTTPException(status_code=422, detail="sub_account requires account (the parent account of the sub-account)")
    configured = configured_key_accounts()
    return MartFilters(account, region, branch, service_type, vertical, job_number, company,
                       scope=scope_value, sub_account=sub, delivery=delivery_value,
                       key_accounts=tuple(a["name"] for a in configured),
                       key_account_labels=tuple((a["name"], a.get("label") or a["name"]) for a in configured))


def job_scope_subquery(filters: MartFilters, column: str) -> tuple[str, list[Any]]:
    """Apply the scope to a fact that is not `mart.job_month` (AR invoices, aging snapshots) by
    restricting `column` to the job numbers the filters select.

    Returns ("", []) when nothing narrows the selection (scope "all" with no other filter), so
    company-wide facts that carry no service location stay in the total instead of being dropped
    by an inner-join-like restriction.
    """
    clause, params = filters.clause("jm")
    if not clause:
        return "", []
    return (f" AND {column} IN (SELECT DISTINCT jm.job_number FROM mart.job_month jm WHERE true{clause})", params)


# ── scope disclosure ─────────────────────────────────────────────────────────
def scope_block(filters: MartFilters) -> dict[str, Any]:
    """`range.scope`: {mode, label, accounts, sites} — what the response is actually showing.

    `sites` is the number of distinct `mart.job_month.job_number` values the whole filter set
    selects across every month (a cheap count, not the period's reporting sites). `accounts` lists
    the accounts that define the scope when they are enumerable: the key accounts for "key", the
    one account for "account"; empty for "all" and for "other" (whose membership is "everything
    else", stated by the label).
    """
    clause, params = filters.clause("jm")
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"SELECT count(DISTINCT jm.job_number) AS sites FROM mart.job_month jm WHERE true{clause}",
            params,
        )
        sites = int((cursor.fetchone() or {}).get("sites") or 0)
    mode = filters.mode
    if mode == SCOPE_ACCOUNT:
        accounts = [filters.account]
    elif mode == SCOPE_KEY:
        accounts = filters.scope_names
    else:
        accounts = []
    return {"mode": mode, "label": filters.label, "accounts": accounts, "sites": sites}


def range_block(rng: MonthRange, filters: MartFilters | None = None) -> dict[str, Any]:
    """The response's `range`: the resolved month range plus the scope it was measured over."""
    block = rng.as_dict()
    block["scope"] = scope_block(filters if filters is not None else MartFilters())
    return block


def envelope(rng: MonthRange, filters: MartFilters | None = None) -> dict[str, Any]:
    """`source` + `range` (with `range.scope`), the head of every reporting response."""
    return {"source": source_block(), "range": range_block(rng, filters)}


# ── settings ─────────────────────────────────────────────────────────────────
def read_settings() -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT key, value FROM ops.app_setting")
        return {row["key"]: row["value"] for row in cursor.fetchall()}


def read_setting(key: str, default: Any = None) -> Any:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (key,))
        row = cursor.fetchone()
        return row["value"] if row else default


# ── source disclosure ────────────────────────────────────────────────────────
def primary_source_of(cursor: Any) -> str:
    """ops.app_setting.primary_source: which loader last filled the marts (winteam_api | finance_reference | none)."""
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'primary_source'")
    row = cursor.fetchone()
    value = row["value"] if row else None
    return value if isinstance(value, str) and value in PRIMARY_SOURCES else "none"


def source_block() -> dict[str, Any]:
    """Tells the browser whether marts hold live data, which source filled them, and how fresh they are.

    `primary_source` is 'finance_reference' after a reference load and 'winteam_api' after a WinTeam
    sync; `ar_as_of` is the AR aging snapshot date the open balances refer to (reference source only).
    """
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT (SELECT max(month) FROM mart.portfolio_month) AS latest_month,
                   (SELECT count(*) FROM mart.job_month) AS job_month_rows,
                   (SELECT max(completed_at) FROM mart.rebuild_log WHERE status = 'succeeded') AS rebuilt_at,
                   (SELECT max(completed_at) FROM ops.integration_sync_run WHERE status = 'succeeded') AS synced_at
            """
        )
        row = cursor.fetchone() or {}
        primary = primary_source_of(cursor)
        if (row.get("job_month_rows") or 0) == 0:
            primary = "none"
        ar_as_of: date | None = None
        if primary == "finance_reference":
            cursor.execute("SELECT max(snapshot_date) AS d FROM core.fact_ar_aging_snapshot")
            snap = cursor.fetchone()
            ar_as_of = snap["d"] if snap else None
    rebuilt_at: datetime | None = row.get("rebuilt_at")
    stale = bool(rebuilt_at) and (datetime.now(timezone.utc) - rebuilt_at) > timedelta(hours=36)
    return {
        "mode": "live" if (row.get("job_month_rows") or 0) > 0 else "empty",
        "as_of": rebuilt_at.isoformat() if rebuilt_at else None,
        "synced_at": row["synced_at"].isoformat() if row.get("synced_at") else None,
        "latest_month": row["latest_month"].isoformat() if row.get("latest_month") else None,
        "stale": stale,
        "primary_source": primary,
        "ar_as_of": ar_as_of.isoformat() if ar_as_of else None,
    }


def jsonable(value: Any) -> Any:
    """Coerce Decimal/date values from psycopg rows into JSON-friendly primitives."""
    from decimal import Decimal

    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


def dumps(value: Any) -> str:
    return json.dumps(jsonable(value))
