"""The month-end rollup row (app/month.py), without a database."""
from __future__ import annotations

from datetime import date

import pytest

from app import month

BASE = {
    "company": "Crane", "job_number": "F100", "site_name": "Station", "parent_account": "FedEx", "hours": 400.0, "ot_hours": 20.0,
    "labor": 8000.0, "pay_report": True, "ot_dollars": 600.0, "budget_hours": 380.0, "budget_dollars": 7600.0, "employees": 6,
    "days_with_labor": 30, "delivery_model": "subcontracted", "sub_projected": 5000.0, "rm_budget_hours": 380.0,
    "latitude": 32.9, "longitude": -96.7, "city": "Plano", "state_province": "TX", "parent_job_number": None,
    "jc_revenue": None, "jc_sub": None, "management_wages": 1200.0, "ar_revenue": None, "ar_invoices": 0, "relay_ap": None,
    "payables": 0, "prior_revenue": 20000.0, "prior_labor": 7000.0, "prior_sub": 4000.0, "last_revenue": 19000.0,
    "last_ar": None, "contract_ar": None, "sub_expected": True,
}
FIRST, LAST = date(2026, 8, 1), date(2026, 8, 31)


def row(**kw):
    return month.month_row({**BASE, **kw}, {("Crane", "F100"): {"account_slug": "fedex", "role": "site", "segment": "Ground"}}, FIRST, LAST)


def test_month_bounds():
    assert month.month_bounds("2026-08") == (date(2026, 8, 1), date(2026, 8, 31), date(2026, 7, 1))
    assert month.month_bounds("2026-01") == (date(2026, 1, 1), date(2026, 1, 31), date(2025, 12, 1))
    assert month.month_bounds("2026-12")[1] == date(2026, 12, 31)
    with pytest.raises(ValueError):
        month.month_bounds("2026-13")


@pytest.mark.parametrize("kw,basis,amount", [
    ({"jc_revenue": 30000.0, "ar_revenue": 31000.0, "delivery_model": "self_perform"}, "job_cost", 30000.0),
    ({"ar_revenue": 31000.0, "contract_ar": 29000.0}, "relay_ar", 31000.0),
    ({"contract_ar": 29000.0, "last_ar": 28000.0}, "contract", 29000.0),
    ({"last_ar": 28000.0}, "prior_month", 28000.0),
    ({}, "prior_month", 19000.0),
    ({"last_revenue": None}, None, 0.0),
])
def test_revenue_falls_back_in_order(kw, basis, amount):
    r = row(**kw)
    assert (r["revenue_month_basis"], r["revenue_month_amount"], r["invoice_week"]) == (basis, amount, amount)


def test_vendor_prefers_relay_ap_except_on_self_perform():
    assert (row(relay_ap=6000.0, jc_sub=5500.0)["sub_week_basis"], row(relay_ap=6000.0)["sub_week"]) == ("relay_ap", 6000.0)
    assert row(relay_ap=6000.0, jc_sub=5500.0, delivery_model="self_perform")["sub_week_basis"] == "job_cost"
    assert row()["sub_week_basis"] == "projected"
    assert row(sub_projected=0)["sub_week_basis"] is None


def test_row_shape_and_sub_invoice_status():
    r = row(payables=2, ar_invoices=1)
    assert r["week_start"] == "2026-08-01" and r["week_end"] == "2026-08-31" and r["account_slug"] == "fedex"
    assert r["sub_expected"] and r["sub_received"] and r["ar_invoices"] == 1
    assert not row()["sub_received"]
    assert r["labor_basis"] == "pay_report" and row(pay_report=False)["labor_basis"] == "trailing_rate_estimate"


def test_a_subcontracted_job_takes_relay_ar_before_its_partial_job_cost():
    """Job 296 in August 2026: job cost carries only GL 34000 OS revenue ($4,030); Relay billed $189,144."""
    r = row(jc_revenue=4030.48, ar_revenue=189143.50, relay_ap=189053.69)
    assert (r["revenue_month_basis"], r["revenue_month_amount"], r["sub_week"]) == ("relay_ar", 189143.5, 189053.69)
    assert row(jc_revenue=4030.48)["revenue_month_basis"] == "job_cost"  # no Relay AR yet: job cost
    assert row(jc_revenue=30000.0, ar_revenue=31000.0, delivery_model="self_perform")["revenue_month_basis"] == "job_cost"
