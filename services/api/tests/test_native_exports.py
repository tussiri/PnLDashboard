"""WinTeam exports in their own layouts: the timekeeping labor summary and the Job Cost Analysis by GL
line (app/native_exports.py). Rows are shaped like the real files (2026-08 / 2026-09 exports)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.imports import Parsed
from app.native_exports import job_cost_gl, labor_summary, native_layout

ALIASES = {"ServiceMaster by Sarus Co": "Sarus", "Crane West Opco LLC": "Crane West", "ServiceMaster by Crane IFS": "Crane IFS"}
NUMBERS = {"1": "Crane IFS", "2": "Crane West", "3": "Crane Southwest"}


def labor_row(start="9/14/2026", end="9/20/2026", run="9/21/2026 5:00:15 AM", daily=(7.5, 8, 8, 8, 8, 0, 0), total=None, **extra):
    hours = {f"Hours{i}": "0.000000" for i in range(1, 17)}
    hours.update({f"Hours{i + 1}": f"{h:.6f}" for i, h in enumerate(daily)})
    return {"ExportRunDate": run, "ExportStartDate": start, "ExportEndDate": end, "JobNum": "300", "JobDesc": "Amazon - BDL3/7",
            "CompanyNumber": "1", "CompanyName": "ServiceMaster by Sarus Co", "EmployeeNumber": "30548", "EmployeeName": "redacted",
            "TotalHours": f"{total if total is not None else sum(daily):.6f}", "HoursTypeDescription": "Ops/Regular", **hours,
            "LaborDollars": "790.5000", "OvtHrs": "1.500000", "DTHrs": "0", "OvtDollars": "38.2500", "DTDollars": "0", "JobNumber": "300", **extra}


def test_recognizes_both_layouts():
    assert native_layout(labor_row().keys()) == "labor_summary"
    assert native_layout(["ExportRunDate", "FiscalYear", "FiscalPeriod", "PeriodStartDate", "JobNumber", "GLAccountNumber", "ActualDollars"]) == "job_cost_gl"
    assert native_layout(["JobNumber", "Revenue", "DirectLabor"]) is None


def test_a_week_spreads_over_its_days_by_hours_and_is_labeled_by_company_name():
    parsed = Parsed(kind="pay_report")
    windows = labor_summary([labor_row()], ALIASES, NUMBERS, parsed)
    assert parsed.errors == []
    days = [(r["work_date"], r["total_hours"]) for r in parsed.records]
    assert days == [(date(2026, 9, 14), Decimal("7.5")), (date(2026, 9, 15), Decimal(8)), (date(2026, 9, 16), Decimal(8)),
                    (date(2026, 9, 17), Decimal(8)), (date(2026, 9, 18), Decimal(8))]
    assert {r["company"] for r in parsed.records} == {"Sarus"}  # by name: Sarus company 1 is not Crane IFS
    assert sum(r["total_dollars"] for r in parsed.records) == Decimal("790.5")
    assert sum(r["overtime_hours"] for r in parsed.records) == Decimal("1.5")
    assert sum(r["regular_dollars"] for r in parsed.records) == Decimal("752.25")
    assert windows == {"Sarus": (date(2026, 9, 14), date(2026, 9, 20))}


def test_coverage_stops_the_day_before_the_export_ran():
    parsed = Parsed(kind="pay_report")
    windows = labor_summary([labor_row(run="9/17/2026 5:00:15 AM", daily=(7.5, 8, 8))], ALIASES, NUMBERS, parsed)
    assert windows == {"Sarus": (date(2026, 9, 14), date(2026, 9, 16))}


def test_a_week_whose_days_do_not_reconcile_lands_on_its_first_day():
    parsed = Parsed(kind="pay_report")
    labor_summary([labor_row(daily=(0, 0, 0, 0, 0, 0, 0), total=40)], ALIASES, NUMBERS, parsed)
    assert [(r["work_date"], r["total_hours"], r["total_dollars"]) for r in parsed.records] == [(date(2026, 9, 14), Decimal(40), Decimal("790.5"))]


def test_a_month_long_window_that_does_not_reconcile_is_refused():
    parsed = Parsed(kind="pay_report")
    labor_summary([labor_row(start="9/1/2026", end="9/30/2026", run="9/29/2026 5:00:15 AM", daily=(7.7,) * 11, total=167.91)], ALIASES, NUMBERS, parsed)
    assert parsed.records == [] and "one Monday-Sunday week" in parsed.errors[0]


def test_a_month_long_window_loads_nothing_even_when_some_rows_reconcile():
    # The hours budget comparison run for a month: rows worked only in its first days reconcile, the rest
    # cannot be split, and a half-loaded window would be marked covered with part of its labor.
    parsed = Parsed(kind="pay_report")
    rows = [labor_row(start="9/1/2026", end="9/30/2026", run="9/30/2026 5:00:07 AM", daily=(8, 8, 8), total=24),
            labor_row(start="9/1/2026", end="9/30/2026", run="9/30/2026 5:00:07 AM", daily=(0,) * 7, total=11.47)]
    assert labor_summary(rows, ALIASES, NUMBERS, parsed) == {}
    assert parsed.records == [] and parsed.errors[0].startswith("1 row(s) cannot be split into weeks")


def jca(job, company_no, company, gl, dollars, hours="0", ot="0", period="7/1/2026", desc="Job"):
    return {"ExportRunDate": "8/2/2026 5:00:13 AM", "FiscalYear": "2026", "FiscalPeriod": "7", "PeriodStartDate": period, "PeriodEndDate": "7/31/2026",
            "CompanyNumber": company_no, "CompanyName": company, "JobNumber": job, "JobDescription": desc, "Type": "1", "GLAccountNumber": gl,
            "GLAccountDescription": "", "ActualDollars": dollars, "ActualHours": hours, "ActualOvertimeHours": ot}


def test_job_cost_gl_lines_pivot_into_one_job_month():
    parsed = Parsed(kind="job_cost")
    job_cost_gl([
        jca("39", "2", "Crane West Opco LLC", "31800", "45000.00", desc="FedEx - Bloomington, CA"),
        jca("39", "2", "Crane West Opco LLC", "34000", "33952.73"),
        jca("39", "2", "Crane West Opco LLC", "40100", "19674.57", hours="1040.5", ot="80.2"),
        jca("39", "2", "Crane West Opco LLC", "40200", "1000.00"),
        jca("39", "2", "Crane West Opco LLC", "44000", "250.00"),
        jca("300", "1", "ServiceMaster by Sarus Co", "40100", "327906.38", hours="16256.62", ot="3028.11"),
        jca("300", "1", "ServiceMaster by Sarus Co", "", "999.00"),  # a subtotal row carries no account
        jca("300", "1", "ServiceMaster by Sarus Co", "70100", "12.00"),
    ], ALIASES, NUMBERS, parsed)
    by_job = {(r["company"], r["job_number"]): r for r in parsed.records}
    fedex = by_job[("Crane West", "39")]
    assert fedex["period"] == date(2026, 7, 1) and fedex["job_name"] == "FedEx - Bloomington, CA"
    assert (fedex["revenue"], fedex["revenue_variable"], fedex["revenue_fixed"]) == (Decimal("78952.73"), Decimal("33952.73"), Decimal("45000.00"))
    assert (fedex["direct_labor"], fedex["subcontractors"], fedex["actual_hours"], fedex["overtime_hours"]) == (Decimal("20674.57"), Decimal("250.00"), Decimal("1040.5"), Decimal("80.2"))
    sarus = by_job[("Sarus", "300")]
    assert sarus["direct_labor"] == Decimal("327906.38") and sarus["revenue_variable"] is None
    assert parsed.errors == ["GL accounts outside the job cost map, not loaded: 70100"]
