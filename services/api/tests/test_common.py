"""Period resolution and mart filter clauses (pure functions)."""
from __future__ import annotations

from datetime import date

import pytest
from fastapi import HTTPException

from app.common import SCOPE_ALL, MartFilters, add_months, month_end, resolve_range

AUG = date(2026, 8, 1)


def test_mtd() -> None:
    rng = resolve_range("MTD", date(2026, 8, 15))
    assert (rng.start, rng.end, rng.months) == (AUG, AUG, 1)
    prior = rng.prior()
    assert (prior.start, prior.end) == (date(2026, 7, 1), date(2026, 7, 1))


def test_qtd() -> None:
    rng = resolve_range("QTD", AUG)
    assert (rng.start, rng.end, rng.months) == (date(2026, 7, 1), AUG, 2)
    prior = rng.prior()
    assert (prior.start, prior.end, prior.months) == (date(2026, 4, 1), date(2026, 5, 1), 2)


def test_ytd_default_and_case_insensitive() -> None:
    rng = resolve_range("ytd", AUG)
    assert (rng.start, rng.end, rng.months) == (date(2026, 1, 1), AUG, 8)
    prior = rng.prior()
    assert (prior.start, prior.end, prior.months) == (date(2025, 1, 1), date(2025, 8, 1), 8)
    assert resolve_range("", AUG).period == "YTD"


def test_t12m() -> None:
    rng = resolve_range("T12M", AUG)
    assert (rng.start, rng.end, rng.months) == (date(2025, 9, 1), AUG, 12)
    prior = rng.prior()
    assert (prior.start, prior.end, prior.months) == (date(2024, 9, 1), date(2025, 8, 1), 12)


def test_january_qtd_and_year_boundaries() -> None:
    rng = resolve_range("QTD", date(2026, 1, 1))
    assert (rng.start, rng.end, rng.months) == (date(2026, 1, 1), date(2026, 1, 1), 1)
    assert rng.prior().start == date(2025, 10, 1)
    assert add_months(date(2026, 1, 1), -1) == date(2025, 12, 1)
    assert add_months(date(2025, 11, 1), 3) == date(2026, 2, 1)
    assert month_end(date(2026, 2, 1)) == date(2026, 2, 28)


def test_invalid_period() -> None:
    with pytest.raises(HTTPException) as excinfo:
        resolve_range("WEEK", AUG)
    assert excinfo.value.status_code == 422


def test_as_dict() -> None:
    payload = resolve_range("YTD", AUG).as_dict()
    assert payload == {"from": "2026-01-01", "to": "2026-08-01", "months": 8, "period": "YTD", "anchor": "2026-08-01"}


def test_filter_clause_empty() -> None:
    # scope="all" is the only mode that emits nothing; "key" is now the default (see test_scope.py).
    assert MartFilters(scope=SCOPE_ALL).clause() == ("", [])
    assert MartFilters(account="All", region="", scope=SCOPE_ALL).clause() == ("", [])


def test_filter_clause_parameterized_in_fixed_order() -> None:
    filters = MartFilters(region="Midwest Region", account="Vandelay Industries", job_number="10002z")
    clause, params = filters.clause("d")
    # an explicit account IS the scope, so the key-account test contributes nothing here
    assert clause == " AND d.parent_account = %s AND d.region = %s AND d.job_number = %s"
    assert params == ["Vandelay Industries", "Midwest Region", "10002z"]
    assert filters.active() == {"account": "Vandelay Industries", "region": "Midwest Region", "job_number": "10002z"}
