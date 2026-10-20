"""The company P&L (app/company_pnl.py) and its two new feeds: the Cross Tab Income Statement by job
(app/job_income_statement.py) and the contract schedule (app/contract_billing.py). No database."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from app import company_pnl, contract_billing, job_income_statement
from app.company_pnl import DEFAULT_SETTINGS, LINES, apply_adjustments, compute, group_of, validate_settings
from app.imports import Parsed

SEP = date(2026, 9, 1)
CFG = validate_settings(DEFAULT_SETTINGS)


def job(revenue=0.0, basis="income_statement", **lines):
    return {"company": "Crane IFS", "job_number": "x", "job_name": None, "basis": basis, "revenue": revenue,
            **{line: float(lines.get(line, 0.0)) for line in LINES}}


# ── Cross Tab Income Statement ──────────────────────────────────────────────
def test_long_layout_reads_period_company_and_flips_credit_signs():
    headers = ["CompanyName", "JobNumber", "GLAccountNumber", "GLDescription", "FiscalYear", "FiscalPeriod", "Amount"]
    rows = [
        {"CompanyName": "ServiceMaster by Crane IFS", "JobNumber": "246", "GLAccountNumber": "30100", "GLDescription": "Revenue",
         "FiscalYear": "2026", "FiscalPeriod": "9", "Amount": "-1000"},
        {"CompanyName": "ServiceMaster by Crane IFS", "JobNumber": "246", "GLAccountNumber": "40100", "GLDescription": "Wages",
         "FiscalYear": "2026", "FiscalPeriod": "9", "Amount": "600"},
        {"CompanyName": "ServiceMaster by Crane IFS", "JobNumber": "246", "GLAccountNumber": "40100", "GLDescription": "Wages",
         "FiscalYear": "2026", "FiscalPeriod": "9", "Amount": "50"},
        {"CompanyName": "", "JobNumber": "Total", "GLAccountNumber": "40100", "Amount": "650"},
        {"CompanyName": "ServiceMaster by Crane IFS", "JobNumber": "246", "GLAccountNumber": "12000", "Amount": "9"},
    ]
    parsed = Parsed(kind="job_income_statement")
    job_income_statement.parse("IS.csv", headers, rows, {"ServiceMaster by Crane IFS": "Crane IFS"}, {}, parsed)
    assert parsed.errors == []
    got = {(r["company"], r["job_number"], r["period"], r["gl_account"]): r["amount"] for r in parsed.records}
    assert got == {("Crane IFS", "246", SEP, 30100): Decimal(1000), ("Crane IFS", "246", SEP, 40100): Decimal(650)}


def test_cross_tab_layout_takes_jobs_from_headers_and_the_month_from_the_name():
    headers = ["Account", "Description", "246 - JANRT", "Job 63252", "Total"]
    rows = [
        {"Account": "30100", "Description": "Revenue", "246 - JANRT": "1,000", "Job 63252": "", "Total": "1000"},
        {"Account": "41000 - Payroll taxes", "Description": None, "246 - JANRT": "80", "Job 63252": "20", "Total": "100"},
        {"Account": "Total cost", "Description": None, "246 - JANRT": "80", "Job 63252": "20", "Total": "100"},
    ]
    assert job_income_statement.layout_of(headers) == "cross_tab"
    parsed = Parsed(kind="job_income_statement")
    job_income_statement.parse("Sarus Cross Tab Sep 2026.xlsx", headers, rows, {}, {}, parsed)
    assert parsed.errors == []
    got = {(r["job_number"], r["gl_account"]): r["amount"] for r in parsed.records}
    assert got == {("246", 30100): Decimal(1000), ("246", 41000): Decimal(80), ("63252", 41000): Decimal(20)}
    assert {r["company"] for r in parsed.records} == {"Sarus"}
    assert {r["period"] for r in parsed.records} == {SEP}


def test_cross_tab_without_a_month_is_refused():
    parsed = Parsed(kind="job_income_statement")
    job_income_statement.parse("cross tab.xlsx", ["Account", "246"], [{"Account": "30100", "246": "1"}], {}, {}, parsed)
    assert parsed.records == [] and "no month" in parsed.errors[0]


@pytest.mark.parametrize("name,expected", [("IS_2026-09.xlsx", SEP), ("Cross Tab 09-2026.csv", SEP), ("September 2026.xlsx", SEP),
                                           ("202609 cross tab.csv", SEP), ("nothing.csv", None)])
def test_period_from_name(name, expected):
    assert job_income_statement.period_from_name(name) == expected


# ── contract schedule ───────────────────────────────────────────────────────
def test_contract_schedule_by_month_columns():
    headers = ["JobNumber", "Facility", "Oct 2026", "2026-11", "12/2026"]
    rows = [{"JobNumber": "5101 - Crowley HS", "Facility": "HS", "Oct 2026": "$392,423", "2026-11": "390000", "12/2026": ""}]
    assert contract_billing.name_matches("Crowley_ISD_Monthly_Revenue_V1.xlsx")
    parsed = Parsed(kind="contract_billing")
    contract_billing.parse("Crowley_ISD_Monthly_Revenue_V1.xlsx", headers, rows, {}, {}, parsed)
    assert parsed.errors == []
    assert [(r["job_number"], r["period"], r["amount"]) for r in parsed.records] == [
        ("5101", date(2026, 10, 1), Decimal(392423)), ("5101", date(2026, 11, 1), Decimal(390000))]


def test_contract_schedule_long_layout_and_missing_columns():
    parsed = Parsed(kind="contract_billing")
    contract_billing.parse("contract schedule.csv", ["JobNumber", "Month", "MonthlyAmount"],
                           [{"JobNumber": "5101", "Month": "2026-09", "MonthlyAmount": "100"}], {}, {}, parsed)
    assert [(r["period"], r["amount"]) for r in parsed.records] == [(SEP, Decimal(100))]
    bad = Parsed(kind="contract_billing")
    contract_billing.parse("contract schedule.csv", ["JobNumber", "Notes"], [], {}, {}, bad)
    assert bad.errors


# ── settings ────────────────────────────────────────────────────────────────
def test_settings_need_exactly_one_default_group_and_unique_keys():
    with pytest.raises(ValueError, match="default"):
        validate_settings({"overhead_jobs": [], "groups": [{"key": "a"}]})
    with pytest.raises(ValueError, match="duplicate"):
        validate_settings({"overhead_jobs": [], "groups": [{"key": "a", "default": True}, {"key": "a"}]})
    with pytest.raises(ValueError, match="delivery_model"):
        validate_settings({"overhead_jobs": [], "groups": [{"key": "a", "default": True, "delivery_model": "x"}]})


def test_fedex_subs_group_takes_only_subcontracted_fedex_sites():
    assert group_of(CFG, "fedex", "subcontracted")["key"] == "fedex_subs"
    assert group_of(CFG, "fedex", "self_perform")["key"] == "core"
    assert group_of(CFG, "plano-isd", None)["key"] == "education"
    assert group_of(CFG, None, None)["key"] == "core"


# ── compute ─────────────────────────────────────────────────────────────────
def september():
    """Four jobs shaped like finance's September company P&L: revenue $9,270,124, before overhead
    $1,300,866, overhead jobs' net cost $1,286,606, net $14,260."""
    jobs = {
        (False, "300"): job(6_000_000, labor=4_000_000, payroll_taxes=500_000, supplies=600_000),       # core: 900,000
        (False, "5101"): job(2_000_000, labor=1_400_000, payroll_taxes=150_000, operating_expenses=50_000),  # education: 400,000
        (False, "7001"): job(1_200_000, subcontractors=1_199_134),                                       # FedEx subs: 866
        (False, "6325"): job(70_124, labor=1_000_000, operating_expenses=356_730),                        # overhead
    }
    info = {(False, "300"): {"account": "amazon", "delivery_model": "self_perform"},
            (False, "5101"): {"account": "crowley-isd", "delivery_model": "self_perform"},
            (False, "7001"): {"account": "fedex", "delivery_model": "subcontracted"}}
    return jobs, info


def test_reproduces_the_company_totals_and_the_overhead_rule():
    jobs, info = september()
    out = compute(SEP, CFG, jobs, info, {}, None, "income_statement")
    assert out["revenue"] == 9_270_124
    assert out["before_overhead"] == 1_300_866
    assert out["overhead"] == 1_286_606
    assert out["net_profit"] == 14_260
    assert out["payroll_taxes_basis"] == "income_statement"
    g = {x["key"]: x for x in out["groups"]}
    assert g["fedex_subs"]["overhead"] == 45_000 and g["fedex_subs"]["pool_share"] == 0
    pool = 1_286_606 - 45_000
    assert out["pool"] == pool
    assert g["core"]["pool_share"] == pytest.approx(pool * 6_000_000 / 8_000_000, abs=0.01)
    assert g["education"]["pool_share"] == pytest.approx(pool * 2_000_000 / 8_000_000, abs=0.01)
    assert sum(x["after_overhead"] for x in out["groups"]) == pytest.approx(out["net_profit"], abs=0.05)
    assert g["education"]["accounts"][0]["account"] == "crowley-isd"
    assert g["education"]["gross_profit"] == 450_000  # operating expenses sit below gross profit


def test_month_overrides_replace_a_groups_fixed_charge():
    jobs, info = september()
    out = compute(SEP, CFG, jobs, info, {(SEP, "fedex_subs"): {"fixed_charge": 50_000, "direct_staff": None}}, None, "income_statement")
    g = {x["key"]: x for x in out["groups"]}
    assert g["fedex_subs"]["overhead"] == 65_000
    assert out["net_profit"] == 14_260  # moving overhead between groups never changes the company total


def test_job_cost_months_estimate_payroll_taxes_from_the_burden_rate():
    jobs = {(False, "300"): job(1000, basis="job_cost", labor=500)}
    out = compute(SEP, CFG, jobs, {}, {}, 0.1, "job_cost")
    assert out["lines"]["payroll_taxes"] == 50 and out["payroll_taxes_basis"] == "estimate"
    assert out["net_profit"] == 450


# ── adjustments ─────────────────────────────────────────────────────────────
def adjustment(**over):
    base = {"adjustment_id": 1, "month": SEP, "kind": "accrual", "line": "subcontractors", "company": "Crane IFS", "job_number": "7001",
            "to_company": None, "to_job_number": None, "amount": Decimal(200_000), "auto_reverse": True, "baseline": Decimal(1_000_000),
            "reversed_at": None}
    return {**base, **over}


def test_an_accrual_adds_cost_until_the_invoices_post():
    jobs = {(False, "7001"): job(1_200_000, subcontractors=1_000_000)}
    out = apply_adjustments(jobs, [adjustment()])
    assert out[0]["status"] == "active" and jobs[(False, "7001")]["subcontractors"] == 1_200_000

    posted = {(False, "7001"): job(1_200_000, subcontractors=1_190_000)}  # 95% of the accrual came in
    out = apply_adjustments(posted, [adjustment()])
    assert out[0]["status"] == "posted" and posted[(False, "7001")]["subcontractors"] == 1_190_000


def test_a_reversed_accrual_does_nothing_and_a_reclass_moves_the_amount():
    jobs = {(False, "7001"): job(subcontractors=1_000_000)}
    out = apply_adjustments(jobs, [adjustment(reversed_at="2026-10-20")])
    assert out[0]["status"] == "reversed" and jobs[(False, "7001")]["subcontractors"] == 1_000_000

    jobs = {(False, "300"): job(1000, labor=500)}
    apply_adjustments(jobs, [adjustment(kind="reclass", line="labor", job_number="300", to_job_number="6325",
                                        amount=Decimal(100), auto_reverse=False, baseline=None)])
    assert jobs[(False, "300")]["labor"] == 400 and jobs[(False, "6325")]["labor"] == 100


def test_adjustment_lines_map_other_onto_other_direct():
    assert company_pnl.adjustment_line("other") == "other_direct"
    assert company_pnl.line_of_account(41500) == "payroll_taxes"
    assert company_pnl.line_of_account(52000) == "operating_expenses"
