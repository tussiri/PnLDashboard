"""Reporting scope: key accounts first (docs/api-contract.md, docs/reporting-scope.md).

Everything here is pure - the SQL fragments MartFilters emits, the precedence between `account` and
`scope`, the validation resolve_filters applies, and the coverage arithmetic. The scope's site count
(`scope_block.sites`) is the one part that needs a database; only its shape is pinned here, against
a fake cursor.
"""
from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from app.common import (DEFAULT_KEY_ACCOUNTS, DELIVERY_SELF, DELIVERY_SUB, SCOPE_ACCOUNT, SCOPE_ALL,
                        SCOPE_KEY, SCOPE_OTHER, MartFilters, delivery_sql, job_scope_subquery,
                        key_accounts_setting, parse_delivery, parse_scope, resolve_filters,
                        scope_block, scope_clause)

KEYS = ("FedEx", "Amazon", "Education", "Whole Foods", "Aldi")


def f(**kwargs: Any) -> MartFilters:
    """A MartFilters with the key accounts resolved (what resolve_filters builds at request time)."""
    return MartFilters(key_accounts=KEYS, **kwargs)


# ── the SQL fragment per scope mode ──────────────────────────────────────────
def test_scope_key_is_the_default_and_emits_a_membership_test() -> None:
    filters = f()
    assert filters.scope == SCOPE_KEY and filters.mode == SCOPE_KEY
    clause, params = filters.clause("jm")
    assert clause == " AND jm.parent_account = ANY(%s::text[])"
    assert params == [list(KEYS)]


def test_scope_other_excludes_the_key_accounts_and_keeps_unassigned_rows() -> None:
    clause, params = f(scope=SCOPE_OTHER).clause("jm")
    # coalesce so a NULL parent_account (unassigned job) counts as "not a key account" instead of
    # dropping out: NULL <> ALL (...) is NULL, which WHERE treats as false.
    assert clause == " AND (coalesce(jm.parent_account, '') <> ALL(%s::text[]))"
    assert params == [list(KEYS)]


def test_scope_all_emits_nothing() -> None:
    assert f(scope=SCOPE_ALL).clause("jm") == ("", [])


def test_alias_is_applied_to_every_scope_fragment() -> None:
    assert f().clause("d")[0] == " AND d.parent_account = ANY(%s::text[])"
    assert f(scope=SCOPE_OTHER).clause("x")[0] == " AND (coalesce(x.parent_account, '') <> ALL(%s::text[]))"


# ── precedence: account > scope ──────────────────────────────────────────────
def test_account_overrides_scope_in_sql_and_in_the_echoed_mode() -> None:
    for scope in (SCOPE_KEY, SCOPE_OTHER, SCOPE_ALL):
        filters = f(account="Amazon", scope=scope)
        clause, params = filters.clause("jm")
        assert clause == " AND jm.parent_account = %s"
        assert params == ["Amazon"]
        assert filters.mode == SCOPE_ACCOUNT
        assert filters.label == "Amazon"
        # the requested scope is not echoed as a filter: the account is the scope
        assert "scope" not in filters.active()


def test_account_all_is_not_an_account() -> None:
    filters = f(account="All")
    assert filters.mode == SCOPE_KEY
    assert filters.clause("jm")[0] == " AND jm.parent_account = ANY(%s::text[])"


# ── sub_account ──────────────────────────────────────────────────────────────
def test_sub_account_is_an_exact_match_after_the_account() -> None:
    clause, params = f(account="FedEx", sub_account="FedEx Express (FXE)").clause("jm")
    assert clause == " AND jm.parent_account = %s AND jm.sub_account = %s"
    assert params == ["FedEx", "FedEx Express (FXE)"]


def test_sub_account_without_account_is_a_422() -> None:
    # called directly, so every query parameter is passed explicitly (FastAPI would bind them)
    with pytest.raises(HTTPException) as excinfo:
        resolve_filters(account=None, region=None, branch=None, service_type=None, vertical=None,
                        job_number=None, company=None, scope=None,
                        sub_account="Plano Independent School District", delivery=None)
    assert excinfo.value.status_code == 422
    with pytest.raises(HTTPException):
        resolve_filters(account="All", region=None, branch=None, service_type=None, vertical=None,
                        job_number=None, company=None, scope=None,
                        sub_account="Plano Independent School District", delivery=None)


# ── delivery ─────────────────────────────────────────────────────────────────
def test_delivery_rule_is_the_executive_rule_qualified_by_the_alias() -> None:
    assert delivery_sql() == ("coalesce(delivery_model, CASE WHEN hours > 0 "
                              f"THEN '{DELIVERY_SELF}' ELSE '{DELIVERY_SUB}' END)")
    assert delivery_sql("jm") == ("coalesce(jm.delivery_model, CASE WHEN jm.hours > 0 "
                                  f"THEN '{DELIVERY_SELF}' ELSE '{DELIVERY_SUB}' END)")


def test_delivery_filter_compares_the_rule_and_all_emits_nothing() -> None:
    clause, params = f(scope=SCOPE_ALL, delivery=DELIVERY_SUB).clause("jm")
    assert clause == f" AND {delivery_sql('jm')} = %s"
    assert params == [DELIVERY_SUB]
    assert f(scope=SCOPE_ALL, delivery="all").clause("jm") == ("", [])


def test_scope_clause_and_mart_filters_agree_on_the_key_account_test() -> None:
    """The executive weekly view and the reporting scope must not drift apart."""
    weekly_clause, weekly_params = scope_clause(None, list(KEYS))
    report_clause, report_params = f().clause()
    assert weekly_clause == report_clause.replace("jm.", "")
    assert weekly_params == report_params


# ── validation ───────────────────────────────────────────────────────────────
def test_unknown_scope_and_delivery_are_422() -> None:
    assert parse_scope(None) == SCOPE_KEY
    assert parse_scope(" KEY ") == SCOPE_KEY
    assert parse_delivery(None) == "all"
    for bad in ("keys", "mine", "none"):
        with pytest.raises(HTTPException) as excinfo:
            parse_scope(bad)
        assert excinfo.value.status_code == 422
    with pytest.raises(HTTPException) as excinfo:
        parse_delivery("sub")
    assert excinfo.value.status_code == 422


def test_key_accounts_setting_normalization_and_fallback() -> None:
    assert key_accounts_setting(None) == DEFAULT_KEY_ACCOUNTS
    assert key_accounts_setting([]) == DEFAULT_KEY_ACCOUNTS
    assert key_accounts_setting([" Amazon ", {"name": "FedEx", "label": "FedEx (all)"}, {"label": "no name"}, 7]) == [
        {"name": "Amazon", "label": "Amazon"}, {"name": "FedEx", "label": "FedEx (all)"}]


def test_unresolved_key_accounts_fall_back_to_the_defaults_never_to_an_empty_set() -> None:
    """An empty membership test would silently return no rows; the defaults are used instead."""
    _, params = MartFilters().clause("jm")
    assert params == [[a["name"] for a in DEFAULT_KEY_ACCOUNTS]]


# ── the echoed filter set ────────────────────────────────────────────────────
def test_active_echoes_the_narrowing_filters_only() -> None:
    assert f().active() == {"scope": SCOPE_KEY}
    assert f(scope=SCOPE_ALL).active() == {}
    assert f(scope=SCOPE_OTHER, delivery=DELIVERY_SELF).active() == {"scope": SCOPE_OTHER, "delivery": DELIVERY_SELF}
    assert f(account="FedEx", sub_account="FedEx Ground (FXG)").active() == {
        "account": "FedEx", "sub_account": "FedEx Ground (FXG)"}
    assert "key_accounts" not in f().active()


def test_labels_name_what_the_view_is_showing() -> None:
    assert f().label == "Key accounts"
    assert f(scope=SCOPE_OTHER).label == "Other accounts"
    assert f(scope=SCOPE_ALL).label == "All accounts"
    # A key account is named by its configured display label, so the scope line and the account
    # selector agree ("School districts", not the raw `Education` group name).
    assert f(account="FedEx", sub_account="FedEx Express (FXE)").label == "FedEx (incl. FXE, FXG) / FedEx Express (FXE)"
    assert f(account="Education").label == "School districts"
    assert f(account="CoreSite Real Estate, LLC").label == "CoreSite Real Estate, LLC"
    assert f(delivery=DELIVERY_SUB).label == "Key accounts / subcontracted sites"


# ── scope_block ──────────────────────────────────────────────────────────────
class _FakeCursor:
    """Records the SQL/params and answers the single site count scope_block asks for."""

    def __init__(self, sites: int) -> None:
        self.sites = sites
        self.sql: str = ""
        self.params: Any = None

    def execute(self, sql: str, params: Any = None) -> None:
        self.sql, self.params = sql, params

    def fetchone(self) -> dict[str, Any]:
        return {"sites": self.sites}

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def __enter__(self) -> "_FakeConnection":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


@pytest.fixture()
def fake_db(monkeypatch: pytest.MonkeyPatch) -> _FakeCursor:
    from app import common

    cursor = _FakeCursor(526)
    monkeypatch.setattr(common, "connection", lambda: _FakeConnection(cursor))
    return cursor


def test_scope_block_shape_key(fake_db: _FakeCursor) -> None:
    block = scope_block(f())
    assert block == {"mode": SCOPE_KEY, "label": "Key accounts", "accounts": list(KEYS), "sites": 526}
    assert "count(DISTINCT jm.job_number)" in fake_db.sql and "mart.job_month" in fake_db.sql
    assert fake_db.params == [list(KEYS)]


def test_scope_block_shape_account_and_other_and_all(fake_db: _FakeCursor) -> None:
    assert scope_block(f(account="Amazon")) == {
        "mode": SCOPE_ACCOUNT, "label": "Amazon", "accounts": ["Amazon"], "sites": 526}
    other = scope_block(f(scope=SCOPE_OTHER))
    assert other["mode"] == SCOPE_OTHER and other["accounts"] == []
    every = scope_block(f(scope=SCOPE_ALL))
    assert every["mode"] == SCOPE_ALL and every["accounts"] == []


# ── non-job_month facts (AR / AP) ────────────────────────────────────────────
def test_job_scope_subquery_restricts_ar_to_the_scope_job_numbers() -> None:
    clause, params = job_scope_subquery(f(), "o.job_number")
    assert clause == (" AND o.job_number IN (SELECT DISTINCT jm.job_number FROM mart.job_month jm "
                      "WHERE true AND jm.parent_account = ANY(%s::text[]))")
    assert params == [list(KEYS)]


def test_job_scope_subquery_is_empty_when_nothing_narrows() -> None:
    """scope=all with no other filter must not drop invoices that carry no service location."""
    assert job_scope_subquery(f(scope=SCOPE_ALL), "o.job_number") == ("", [])


# ── coverage arithmetic ──────────────────────────────────────────────────────
def share_of_all(scope_revenue: float, all_revenue: float) -> float | None:
    """The pure rule behind /portfolio/summary.kpis.revenue_share_of_all (reporting.ratio)."""
    from app.routers.reporting import ratio

    return ratio(scope_revenue, all_revenue or None)


def test_revenue_share_of_all() -> None:
    assert share_of_all(32_600_000.0, 35_000_000.0) == 0.9314
    assert share_of_all(35_000_000.0, 35_000_000.0) == 1.0
    assert share_of_all(0.0, 35_000_000.0) == 0.0
    # null, never a divide-by-zero, when nothing was invoiced in the range
    assert share_of_all(0.0, 0.0) is None
    assert share_of_all(1_000.0, 0.0) is None
