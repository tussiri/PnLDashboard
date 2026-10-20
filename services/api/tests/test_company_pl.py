"""The company P&L on Finance's basis (app/company_pl.py), without a database."""
from __future__ import annotations

from datetime import date

import pytest

from app import company_pl, imports

CFG = company_pl.validate_settings(company_pl.DEFAULT_SETTINGS)

CROSS_TAB = """Crane IFS
Cross Tab Income Statement by Job
For the Period 9/1/2026 to 9/30/2026
Account,101 - Amazon DFW7,246 - FedEx JANRT,801 - Plano Academy HS,6325 - Corporate,Total
40000 Revenue,"100,000.00","50,000.00","20,000.00","1,000.00","171,000.00"
Total Revenue,"100,000.00","50,000.00","20,000.00","1,000.00","171,000.00"
50100 Wages,"60,000.00",,"15,000.00","30,000.00","105,000.00"
50300 Payroll Taxes,"6,000.00",,"1,500.00","3,000.00","10,500.00"
50400 Workers Comp,"1,000.00",,(200.00),,800.00
51000 Subcontractors,,"40,000.00",,,"40,000.00"
52000 Cleaning Supplies,"2,000.00",,500.00,,"2,500.00"
60500 Rent,,,,"20,000.00","20,000.00"
70100 Vehicle Expense,500.00,,,"1,000.00","1,500.00"
Gross Profit,"30,500.00","10,000.00","3,200.00",,
Net Income,"30,000.00","10,000.00","3,200.00","-53,000.00",
"""


def test_a_wide_cross_tab_with_title_rows_is_read_by_job_and_line():
    parsed = company_pl.parse("Cross Tab Sep.csv", CROSS_TAB.encode(), [], ["Crane IFS"])
    assert not parsed.errors
    by = {(r["job_number"], r["category"]): r for r in parsed.records}
    assert {r["month"] for r in parsed.records} == {date(2026, 9, 1)}
    assert {r["company"] for r in parsed.records} == {"Crane IFS"}
    assert by[("101", "revenue")]["amount"] == 100000 and by[("101", "revenue")]["job_name"] == "Amazon DFW7"
    # Workers comp and payroll taxes are both payroll taxes and insurance; subtotal rows are skipped.
    taxes = sum(r["amount"] for r in parsed.records if r["job_number"] == "801" and r["category"] == "payroll_taxes_insurance")
    assert taxes == 1300
    assert not any("grossprofit" in r["line"] or r["line"].startswith("total") for r in parsed.records)
    assert by[("246", "subcontractors")]["amount"] == 40000
    assert sum(r["amount"] for r in parsed.records if r["job_number"] == "6325" and r["category"] == "operating_expense") == 21000  # rent + vehicle


def test_gl_ranges_win_over_line_names_and_credit_revenue_is_flipped():
    text = "Account,101,102\n40000 Contract Billing,-500,-300\n59000 Misc,100,50\n"
    parsed = company_pl.parse("job_income_statement_2026-08.csv", text.encode(), [{"from": "59000", "to": "59999", "category": "supplies"}])
    by = {(r["job_number"], r["category"]): r["amount"] for r in parsed.records}
    assert by[("101", "revenue")] == 500 and by[("101", "supplies")] == -100  # flipped with the rest
    assert {r["month"] for r in parsed.records} == {date(2026, 8, 1)}


def test_a_long_file_and_a_missing_month():
    long_text = "Job Number,Period,Description,Amount\n101,2026-09,Revenue,1000\n101,2026-09,Wages,600\n"
    parsed = company_pl.parse("lines.csv", long_text.encode(), [])
    assert sorted((r["category"], r["amount"]) for r in parsed.records) == [("direct_labor", 600), ("revenue", 1000)]
    no_month = company_pl.parse("lines.csv", b"Account,101,102\nRevenue,1,2\n", [])
    assert not no_month.records and "no month" in no_month.errors[0]


def test_detect_kind_for_the_new_feeds():
    assert imports.detect_kind("job_income_statement_2026-09.xlsx", []) == "job_income_statement"
    assert imports.detect_kind("income_statement_company.csv", []) == "income_statement"
    assert imports.detect_kind("Cross Tab Income Statement Sep 2026.xlsx", []) == "job_income_statement"
    assert imports.detect_kind("anything.csv", ["Company", "Job Number", "Effective From", "Monthly Amount"]) == "contract"


META = {("Crane IFS", "101"): {"account": "amazon", "delivery_model": "self_perform"},
        ("Crane IFS", "246"): {"account": "fedex", "delivery_model": "subcontracted"},
        ("Crane IFS", "801"): {"account": "plano-isd", "delivery_model": "self_perform"}}


def lines_of(parsed):
    return [{"company": r["company"], "job_number": r["job_number"], "category": r["category"], "amount": float(r["amount"])} for r in parsed.records]


def test_the_overhead_rule_fixed_staff_then_pool_by_revenue_adds_up_to_net():
    parsed = company_pl.parse("x.csv", CROSS_TAB.encode(), [], ["Crane IFS"])
    staff = {"adjustment_id": 1, "month": date(2026, 9, 1), "kind": "staff", "category": "operating_expense", "amount": 5000, "group_key": "education",
             "description": "Education account manager"}
    m = company_pl.build_month(date(2026, 9, 1), lines_of(parsed), META, [staff], CFG)
    c = m["company"]
    assert c["revenue"] == 171000 and c["operating_revenue"] == 170000
    # Overhead: 30,000 wages + 3,000 taxes + 20,000 rent + 1,000 vehicle − 1,000 revenue posted to 6325.
    assert c["overhead"] == 53000
    g = {x["key"]: x for x in m["groups"]}
    assert g["fedex_subs"]["fixed_charge"] == 30000 and g["fedex_subs"]["pool_charge"] == 0
    assert g["education"]["direct_staff"] == 5000
    pool = 53000 - 30000 - 5000
    assert m["overhead"]["pool"] == pool
    assert g["core"]["pool_charge"] == pytest.approx(pool * 100000 / 120000, abs=0.01)
    assert g["education"]["pool_charge"] == pytest.approx(pool * 20000 / 120000, abs=0.01)
    assert sum(x["after_overhead"] for x in m["groups"]) == pytest.approx(c["net_profit"], abs=0.05)
    assert c["net_profit"] == pytest.approx(c["before_overhead"] - 53000, abs=0.01)
    # An account carries its group's overhead by revenue.
    assert m["accounts"]["plano-isd"]["overhead"] == pytest.approx(g["education"]["overhead"], abs=0.01)
    # Gross profit counts payroll taxes; before overhead takes the job's operating expenses too.
    amazon = m["accounts"]["amazon"]
    assert amazon["gross_profit"] == 100000 - 60000 - 6000 - 1000 - 2000 and amazon["before_overhead"] == amazon["gross_profit"] - 500


def test_accruals_reverse_or_clear_and_reclasses_move_between_jobs():
    sep, octo = date(2026, 9, 1), date(2026, 10, 1)
    lines = [{"company": "Crane IFS", "job_number": "246", "category": "revenue", "amount": 50000.0},
             {"company": "Crane IFS", "job_number": "246", "category": "subcontractors", "amount": 20000.0},
             {"company": "Crane IFS", "job_number": "6325", "category": "revenue", "amount": 40000.0}]
    accrual = {"adjustment_id": 1, "month": sep, "kind": "accrual", "category": "subcontractors", "amount": 20000, "to_company": "Crane IFS",
               "to_job": "246", "description": "Sub invoices not received", "reverse_month": octo, "cleared_at": None}
    fee = {"adjustment_id": 2, "month": sep, "kind": "reclass", "category": "revenue", "amount": 40000, "from_company": "Crane IFS",
           "from_job": "6325", "to_company": "Crane IFS", "to_job": "101", "description": "Amazon management fee"}
    m = company_pl.build_month(sep, lines, META, [accrual, fee], CFG)
    assert m["accounts"]["fedex"]["subcontractors"] == 40000
    assert m["accounts"]["amazon"]["revenue"] == 40000 and m["overhead"]["revenue_on_overhead_jobs"] == 0
    o = company_pl.build_month(octo, [], META, [accrual, fee], CFG)
    assert o["accounts"]["fedex"]["subcontractors"] == -20000 and o["adjustments"][0]["reversal"]
    cleared = company_pl.build_month(sep, lines, META, [{**accrual, "cleared_at": "2026-10-20"}], CFG)
    assert cleared["accounts"]["fedex"]["subcontractors"] == 20000


def test_settings_and_adjustments_are_validated():
    with pytest.raises(ValueError, match="rest"):
        company_pl.validate_settings({**company_pl.DEFAULT_SETTINGS, "groups": [{"key": "a", "name": "A", "shares_pool": True}]})
    with pytest.raises(ValueError, match="gl_categories"):
        company_pl.validate_settings({**company_pl.DEFAULT_SETTINGS, "gl_categories": [{"from": "4", "to": "3", "category": "nope"}]})
    groups = CFG["groups"]
    with pytest.raises(ValueError, match="job it posts to"):
        company_pl.validate_adjustment({"month": "2026-09", "kind": "accrual", "category": "subcontractors", "amount": 1, "description": "x"}, groups)
    with pytest.raises(ValueError, match="later month"):
        company_pl.validate_adjustment({"month": "2026-09", "kind": "accrual", "category": "subcontractors", "amount": 1, "description": "x",
                                        "to_job": "246", "reverse_month": "2026-09"}, groups)
    ok = company_pl.validate_adjustment({"month": "2026-09-15", "kind": "staff", "amount": 100, "description": "x", "group_key": "core"}, groups)
    assert ok["month"] == date(2026, 9, 1) and ok["category"] == "operating_expense"


def test_contract_rows():
    parsed = company_pl.parse_contracts(["Company", "Job Number", "Effective From", "Monthly Amount"],
                                        [{"Company": "Crane Southwest", "Job Number": "918", "Effective From": "10/1/2026", "Monthly Amount": "25,575.00"},
                                         {"Company": "", "Job Number": "", "Effective From": "x", "Monthly Amount": "1"}])
    assert parsed.records == [{"company": "Crane Southwest", "job_number": "918", "effective_from": date(2026, 10, 1), "period": date(2026, 10, 1),
                               "monthly_amount": 25575}]
    assert len(parsed.errors) == 1
