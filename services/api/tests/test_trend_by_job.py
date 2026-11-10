"""The Trend Income Statement by job query (FormatID 6) loaded as the Cross Tab by job (no database)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app import native_exports
from app.imports import Parsed

HEAD = ["ExportRunDate", "FiscalYear", "LastClosedMonthEnd", "tier1ID", "jobnumber", "jobdescription", "PrintOrder", "Type",
        "GLAccountDescription", "NormallyADebit"] + [f"amount{i}" for i in range(1, 13)] + ["TotalAmount"]


def row(job, desc, debit, amounts, closed="2026-10-31", **extra):
    values = dict(zip(HEAD, ["2026-11-10", 2027, closed, "1", job, f"Plano - {job}" if job else None, 1, 2, desc, "True" if debit else "False"]
                      + [str(a) for a in ([0] + amounts + [0] * 12)[:12]] + [sum(amounts)]))
    return values | extra


def test_detects_the_query_and_routes_it_to_the_cross_tab():
    assert native_exports.native_layout(HEAD) == "trend_by_job"
    assert native_exports.LAYOUT_KIND["trend_by_job"] == "job_income_statement"
    # WinTeam's own statement (no FiscalYear / LastClosedMonthEnd) stays the company statement.
    assert native_exports.native_layout([h for h in HEAD if h not in ("FiscalYear", "LastClosedMonthEnd")]) == "trend_income_statement"


def test_fiscal_periods_map_to_fy27_months_with_revenue_positive():
    rows = [row("801", "JANITORIAL: Education", False, [-1000, -1100, -1200, -1300]),
            row("801", "DIRECT LABOR:Production Wages - Reg/OT", True, [800, 900, 1000, 950]),
            row("801", "DIRECT LABOR:Production Wages - Reg/OT", True, [10, 0, 0, 0]),
            row(None, "JANITORIAL: Indstrl, Mnftng, Wrhs - Subcontracted", False, [-50, 0, 0, 0])]
    parsed = Parsed(kind="job_income_statement")
    native_exports.trend_by_job(rows, parsed, {}, [{"from": "40000", "to": "40999", "category": "direct_labor"}])
    by = {(r["month"], r["job_number"], r["line"]): r for r in parsed.records}
    jul, oct_ = date(2026, 7, 1), date(2026, 10, 1)
    assert by[(jul, "801", "JANITORIAL: Education")]["amount"] == Decimal(1000)
    assert by[(jul, "801", "JANITORIAL: Education")]["category"] == "revenue"
    assert by[(oct_, "801", "JANITORIAL: Education")]["amount"] == Decimal(1300)
    wages = by[(jul, "801", "DIRECT LABOR:Production Wages - Reg/OT")]
    assert wages["amount"] == Decimal(810) and wages["category"] == "direct_labor" and wages["company"] == ""
    assert by[(jul, "", "JANITORIAL: Indstrl, Mnftng, Wrhs - Subcontracted")]["job_name"] == "No job"
    assert {r["month"] for r in parsed.records} == {date(2026, m, 1) for m in (7, 8, 9, 10)}


def test_gl_number_and_tenant_columns_are_used_when_present():
    rows = [row("300", "Production supplies", True, [25], GLAccountNumber="45010", TenantDatabase="SarusProd")]
    parsed = Parsed(kind="job_income_statement")
    native_exports.trend_by_job(rows, parsed, {}, [{"from": "45000", "to": "45999", "category": "supplies"}])
    r = parsed.records[0]
    assert r["company"] == "Sarus" and r["category"] == "supplies" and r["gl_account"] == "45010" and r["month"] == date(2026, 7, 1)


def test_template_lines_classify_by_prefix():
    c = native_exports.trend_job_category
    assert c("DIRECT LABOR:Production Wages - Reg/OT") == "direct_labor"
    assert c("DIRECT LABOR:Sales Staff - Commission") == "operating_expense"
    assert c("DIRECT PRODUCTION LABOR TAXES: Payroll Taxes") == "payroll_taxes_insurance"
    assert c("DIRECT PRODUCTION LABOR: Healthcare Benefits") == "payroll_taxes_insurance"
    assert c("DIRECT PRODUCTION LABOR: Employee Incentives") == "direct_labor"
    assert c("Operation Workers Comp Insurance") == "payroll_taxes_insurance"
    assert c("SUBCONTRACTOR: Temp Laborer Wages ") == "subcontractors"
    assert c("DIRECT PRODUCTION RESOURCES:Production Products, S") == "supplies"
    assert c("OTHER PRODUCTION EXPENSE:Laundry Service") == "other_direct"
    assert c("SUPPORT STAFF:Office Staff Wages/OT") == "operating_expense"
    assert c("PROFESSIONAL FEES:HR / Payroll Services") == "operating_expense"
