"""Estimated payroll taxes and insurance (migration 070, app/marts.py ti_rates) and the company burden that
no longer takes them twice (app/routers/leadership.py burden_beyond), without a database."""
from __future__ import annotations

from datetime import date

from app import marts
from app.routers.leadership import burden_beyond
from tests.test_allocations import Cursor


def test_rates_run_from_the_first_statement_month_and_carry_forward():
    cursor = Cursor({date(2026, 8, 1): {"wages": 1000000.0, "payroll_taxes": 80000.0, "workers_comp": 20000.0}})
    rates = marts.ti_rates(cursor, today=date(2026, 11, 9))
    assert rates == {"2026-08-01": 0.1, "2026-09-01": 0.1, "2026-10-01": 0.1, "2026-11-01": 0.1}


def test_a_manual_rate_counts_and_wins_over_the_statement():
    cursor = Cursor({date(2026, 8, 1): {"wages": 1000000.0, "payroll_taxes": 80000.0, "workers_comp": 20000.0}},
                    overrides={date(2026, 7, 1): {"burden_rate": 0.12, "overhead_pool": None},
                               date(2026, 9, 1): {"burden_rate": 0.11, "overhead_pool": None}})
    rates = marts.ti_rates(cursor, today=date(2026, 9, 30))
    assert rates == {"2026-07-01": 0.12, "2026-08-01": 0.1, "2026-09-01": 0.11}


def test_no_statement_or_burden_switched_off_means_no_estimate():
    assert marts.ti_rates(Cursor({}), today=date(2026, 11, 9)) == {}
    off = Cursor({date(2026, 8, 1): {"wages": 1000.0, "payroll_taxes": 100.0}}, settings={"burden": {"enabled": False}})
    assert marts.ti_rates(off, today=date(2026, 11, 9)) == {}


def test_the_estimate_is_only_where_no_actual_exists_and_reaches_gross_profit():
    sql = marts.JOB_MONTH_SQL
    assert "a.ti_rate IS NOT NULL AND a.payroll_ti_cost = 0 AND a.labor_cost <> 0" in sql
    assert "coalesce(a.jc_gross_profit, 0) - a.payroll_ti_estimated" in sql
    assert "coalesce(a.jc_direct_cost, 0) + a.payroll_ti_estimated" in sql
    assert "payroll_ti_cost + payroll_ti_estimated, subcontract_cost" in sql
    assert "sum(payroll_ti_estimated) AS payroll_ti_estimated" in marts.PORTFOLIO_MONTH_SQL


def test_company_burden_is_only_what_gross_profit_does_not_already_carry():
    month = {"direct_labor": 1000000.0, "management_wages": 100000.0, "payroll_taxes": 0.0}
    assert burden_beyond(month, 0.1) == 90000.0
    assert burden_beyond({**month, "payroll_taxes": 100000.0}, 0.1) == 0.0  # estimated on all labor: nothing left
    assert burden_beyond({**month, "payroll_taxes": 60000.0}, 0.1) == 30000.0
