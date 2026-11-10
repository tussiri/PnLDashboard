"""The month-end company view's figures from app/company_pl.py build_month: customers, companies, EBITA
add-backs and each adjustment's effect, without a database."""
from __future__ import annotations

from datetime import date

import pytest

from app import company_pl

CFG = company_pl.validate_settings(company_pl.DEFAULT_SETTINGS)
SEP = date(2026, 9, 1)
META = {("Crane IFS", "101"): {"account": "amazon", "delivery_model": "self_perform", "customer": "Amazon"},
        ("Crane IFS", "102"): {"account": "amazon", "delivery_model": "self_perform", "customer": "Amazon"},
        ("Crane IFS", "246"): {"account": "fedex", "delivery_model": "subcontracted", "customer": "FedEx"},
        ("Crane IFS", "801"): {"account": "plano-isd", "delivery_model": "self_perform", "customer": "Plano ISD"},
        ("Sarus", "S1"): {"account": None, "delivery_model": None, "customer": "Tesla"}}


def line(company, job, category, amount, job_name=None):
    return {"company": company, "job_number": job, "category": category, "amount": amount, "job_name": job_name}


LINES = [
    line("Crane IFS", "101", "revenue", 60000.0), line("Crane IFS", "101", "direct_labor", 40000.0),
    line("Crane IFS", "102", "revenue", 40000.0), line("Crane IFS", "102", "direct_labor", 30000.0),
    line("Crane IFS", "246", "revenue", 50000.0), line("Crane IFS", "246", "subcontractors", 45000.0),
    line("Crane IFS", "801", "revenue", 20000.0), line("Crane IFS", "801", "direct_labor", 15000.0),
    line("Crane IFS", "901", "revenue", 10000.0, "Acme Plant"), line("Crane IFS", "901", "direct_labor", 6000.0, "Acme Plant"),
    line("Crane IFS", "901", "operating_expense", 500.0, "Acme Plant"),
    line("Crane IFS", "6325", "operating_expense", 60000.0),
    line("Sarus", "S1", "revenue", 30000.0), line("Sarus", "S1", "direct_labor", 20000.0),
]


def test_customers_carry_their_jobs_overhead_and_add_up_to_net_profit():
    m = company_pl.build_month(SEP, LINES, META, [], CFG)
    by = {c["name"]: c for c in m["customers"]}
    assert by["Amazon"]["jobs"] == ["101", "102"] and by["Amazon"]["revenue"] == 100000
    # A job with no account or WinTeam customer is named from the Cross Tab.
    assert by["Acme Plant"]["before_overhead"] == 3500 and by["Acme Plant"]["group"] == "core"
    assert by["FedEx"]["overhead"] == 30000 and by["FedEx"]["group"] == "fedex_subs"
    assert sum(c["after_overhead"] for c in m["customers"]) == pytest.approx(m["company"]["net_profit"], abs=0.05)
    assert [c["name"] for c in m["customers"]][0] == "Amazon"


def test_companies_are_their_jobs_less_their_own_overhead_jobs():
    m = company_pl.build_month(SEP, LINES, META, [], CFG)
    crane, sarus = m["companies"]["Crane IFS"], m["companies"]["Sarus"]
    assert sarus == {**sarus, "revenue": 30000, "before_overhead": 10000, "overhead": 0, "net_profit": 10000}
    assert crane["overhead"] == 60000
    assert crane["net_profit"] + sarus["net_profit"] == pytest.approx(m["company"]["net_profit"], abs=0.01)


def test_ebita_adds_back_interest_and_amortization_by_group_but_not_depreciation():
    addbacks = [{"company": "Crane IFS", "job_number": "6325", "kind": "interest", "amount": 20000.0},
                {"company": "Crane IFS", "job_number": "6325", "kind": "depreciation", "amount": 4000.0},
                {"company": "Crane IFS", "job_number": "901", "kind": "amortization", "amount": 500.0}]
    m = company_pl.build_month(SEP, LINES, META, [], CFG, addbacks=addbacks)
    e = m["ebita"]
    assert e["interest"] == 20000 and e["amortization"] == 500 and e["depreciation"] == 4000
    assert e["addback"] == 20500 and e["ebita"] == pytest.approx(m["company"]["net_profit"] + 20500, abs=0.01)
    g = e["groups"]
    assert g["core"]["own"] == 500
    # Corporate add-backs follow the overhead each group carries: FedEx subs carry $30K of the $60K.
    assert g["fedex_subs"]["corporate"] == pytest.approx(10000, abs=0.01)
    assert sum(x["ebita"] for x in g.values()) == pytest.approx(e["ebita"], abs=0.05)


def test_addback_lines_are_classified_by_name_first_match_wins():
    rules = CFG["ebita_addbacks"]
    assert company_pl.addback_kind("71500 Interest Expense", rules) == "interest"
    assert company_pl.addback_kind("Amortization of debt discount", rules) == "amortization"
    assert company_pl.addback_kind("Depreciation Expense", rules) == "depreciation"
    assert company_pl.addback_kind("Payroll Taxes", rules) is None
    with pytest.raises(ValueError, match="ebita_addbacks"):
        company_pl.validate_settings({**company_pl.DEFAULT_SETTINGS, "ebita_addbacks": [{"kind": "rent", "match": "rent"}]})


def test_each_adjustment_reports_its_effect_on_revenue_cost_net_and_groups():
    accrual = {"adjustment_id": 1, "month": SEP, "kind": "accrual", "category": "revenue", "amount": 8000, "to_company": "Crane IFS",
               "to_job": "246", "description": "Pallet billing", "reverse_month": None, "cleared_at": None}
    cost = {**accrual, "adjustment_id": 2, "category": "subcontractors", "amount": 3000, "description": "Sub invoices"}
    fee = {"adjustment_id": 3, "month": SEP, "kind": "reclass", "category": "revenue", "amount": 5000, "from_company": "Crane IFS",
           "from_job": "6325", "to_company": "Crane IFS", "to_job": "101", "description": "Amazon management fee"}
    m = company_pl.build_month(SEP, LINES, META, [accrual, cost, fee], CFG)
    a, c, f = m["adjustments"]
    assert (a["revenue_effect"], a["cost_effect"], a["net_effect"], a["groups"]) == (8000, 0, 8000, {"fedex_subs": 8000})
    assert (c["revenue_effect"], c["cost_effect"], c["net_effect"], c["groups"]) == (0, 3000, -3000, {"fedex_subs": -3000})
    assert f["net_effect"] == 0 and f["groups"] == {"overhead": -5000, "core": 5000} and f["job"] == "101"
    plain = company_pl.build_month(SEP, LINES, META, [], CFG)
    assert m["company"]["net_profit"] - plain["company"]["net_profit"] == pytest.approx(sum(x["net_effect"] for x in m["adjustments"]), abs=0.01)
