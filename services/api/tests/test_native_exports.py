"""WinTeam exports in their own layouts: the timekeeping labor summary and the Job Cost Analysis by GL
line (app/native_exports.py). Rows are shaped like the real files (2026-08 / 2026-09 exports)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from app.imports import Parsed
from app.native_exports import (fiscal_year_start, job_cost_gl, labor_summary, native_layout, paid_timekeeping, trend_income_statement,
                                trend_periods, trend_run_date)

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


def paid_row(**extra):
    """Shaped like the HR dashboard's Paid Timekeeping query with the labor dollar columns (2026-10-19)."""
    return {"TenantDatabase": "WT_ServiceMasterCraneIFS_1532_1", "JobCompanyNumber": "1", "PayrollCompanyNumber": "2",
            "JobNumber": "1", "EmployeeNumber": "50040", "WorkDate": "9/21/2026", "WeekStartDate": "9/21/2026",
            "PayPeriodStart": "9/16/2026", "PayPeriodEnd": "9/30/2026", "HourCategoryID": "1", "HourCategoryName": "Operations",
            "HoursTypeID": "15", "HoursTypeDescription": "Ops/Regular", "RecordTypeID": "5", "CheckStatus": "1",
            "StatusDescription": "Normal", "BatchTypeID": "1", "CheckType": "1", "BatchPosted": "True",
            "RequiresLifecycleReview": "True", "RequiresPaidSplitValidation": "True", "StoredTotalHours": "11.4700",
            "CandidateRegularHours": "8.0000", "StoredOvertimeHours": "3.4700", "StoredDoubleTimeHours": "0.0000",
            "RowsWithMissingHours": "0", "NegativeRegularRowCount": "0", "TimekeepingRowCount": "1", "PayRate": "25.091250",
            "RegularLaborDollars": "200.73", "OvertimeLaborDollars": "117.43", "DoubletimeLaborDollars": "0.00",
            "TotalLaborDollars": "318.16", **extra}


def test_paid_timekeeping_layout_needs_the_dollar_columns():
    assert native_layout(paid_row().keys()) == "paid_timekeeping"
    hr_only = {k: v for k, v in paid_row().items() if not k.endswith("LaborDollars") and k != "PayRate"}
    assert native_layout(hr_only.keys()) is None


def test_paid_timekeeping_rows_become_pay_report_labor():
    parsed = Parsed(kind="pay_report")
    paid_timekeeping([paid_row()], ALIASES, NUMBERS, parsed)
    assert parsed.errors == []
    [r] = parsed.records
    assert (r["company"], r["job_number"], r["employee_number"], r["work_date"]) == ("Crane IFS", "1", "50040", date(2026, 9, 21))
    assert (r["total_hours"], r["overtime_hours"], r["regular_hours"]) == (Decimal("11.4700"), Decimal("3.4700"), Decimal("8.0000"))
    assert (r["total_dollars"], r["overtime_dollars"], r["regular_dollars"]) == (Decimal("318.16"), Decimal("117.43"), Decimal("200.73"))


def test_paid_timekeeping_company_comes_from_the_database_first():
    parsed = Parsed(kind="pay_report")
    paid_timekeeping([paid_row(TenantDatabase="WT_Sarus_1", JobCompanyNumber="1"),
                      paid_row(TenantDatabase="WT_Other", JobCompanyNumber="2")],
                     {**ALIASES, "WT_Other": "Crane Southwest"}, NUMBERS, parsed)
    assert [r["company"] for r in parsed.records] == ["Sarus", "Crane Southwest"]


def test_paid_timekeeping_skips_checks_hr_skips():
    parsed = Parsed(kind="pay_report")
    paid_timekeeping([paid_row(CheckStatus="2"), paid_row(BatchTypeID="3"), paid_row(BatchPosted="False"), paid_row()],
                     ALIASES, NUMBERS, parsed)
    assert len(parsed.records) == 1
    assert parsed.errors == ["3 row(s) for void, replaced, unposted or manual checks were skipped"]


def trend_row(order, description, debit, *amounts, job=None):
    row = {"tier1ID": None, "jobnumber": job, "PrintOrder": str(order), "Type": "2", "GLAccountDescription": description,
           "NormallyADebit": "True" if debit else "False", "TotalAmount": "0.0000", "TotalTaxIns": "0.0000"}
    row.update({f"amount{m}": f"{amounts[m - 1] if m <= len(amounts) else 0:.4f}" for m in range(1, 13)})
    return row


TREND = [
    trend_row(70, "JANITORIAL: Indstrl, Mnftng, Warehouse", False, -1000, -1200),
    trend_row(110, "JANITORIAL: Consumables ", False, 0, 50),  # a debit on a revenue line lowers revenue
    trend_row(250, "DIRECT LABOR:Production Wages - Reg/OT", True, 400, 500),
    trend_row(260, "DIRECT LABOR: Management & Supervisor - Hourly", True, 20, 20),
    trend_row(320, "DIRECT PRODUCTION LABOR TAXES: Payroll Taxes", True, 40, 50),
    trend_row(330, "Operation Workers Comp Insurance", True, 30, 30),
    trend_row(410, "SUBCONTRACTOR: Core Service", True, 200, 250),
    trend_row(750, "OTHER PRODUCTION EXPENSE:Travel Costs", True, 10, 10),
    trend_row(930, "FACILITY EXPENSE:Rent", True, 100, 100),
    trend_row(1520, "SUPPORT STAFF:Office Staff Wages/OT", True, 150, 150),
    trend_row(1640, "SUPPORT STAFF:Payroll Taxes", True, 15, 15),
]


def test_trend_income_statement_is_recognized_from_the_export_as_is():
    assert native_layout(TREND[0].keys()) == "trend_income_statement"
    assert trend_run_date("GL Report Trend Income Statement - 20261020141521050.xlsx") == date(2026, 10, 20)
    assert trend_run_date("statement.xlsx", today=date(2026, 3, 2)) == date(2026, 3, 2)


def test_trend_income_statement_loads_company_months_with_summary_lines():
    parsed = Parsed(kind="income_statement")
    trend_income_statement(TREND, parsed, date(2026, 3, 20))
    assert parsed.errors == []
    assert {r["account"] for r in parsed.records} == {"Company"}
    assert sorted({r["period"] for r in parsed.records}) == [date(2026, 1, 1), date(2026, 2, 1)]  # zero months are left alone
    feb = {r["line"]: r["amount"] for r in parsed.records if r["period"] == date(2026, 2, 1)}
    assert feb["revenue"] == Decimal(1150)
    assert feb["wages"] == Decimal(520) and feb["management_wages"] == Decimal(20)
    assert feb["payroll_taxes"] == Decimal(50)  # support staff taxes are G&A, not burden
    assert feb["workers_comp"] == Decimal(30) and feb["subcontractors"] == Decimal(250) and feb["travel"] == Decimal(10)
    assert feb["gross_profit"] == Decimal(1150 - 500 - 20 - 50 - 30 - 250 - 10)
    assert feb["admin"] == Decimal(265)
    assert feb["net_profit"] == feb["gross_profit"] - Decimal(265)
    assert feb["gl:JANITORIAL: Indstrl, Mnftng, Warehouse"] == Decimal(1200)


def test_fiscal_years_are_calendar_until_a_six_period_fy26_then_july_to_june():
    assert fiscal_year_start(date(2025, 11, 1)) == date(2025, 1, 1)
    assert fiscal_year_start(date(2026, 6, 1)) == date(2026, 1, 1)
    assert fiscal_year_start(date(2026, 9, 1)) == date(2026, 7, 1)
    assert fiscal_year_start(date(2027, 3, 1)) == date(2026, 7, 1)


def test_trend_periods_pick_the_latest_fiscal_year_the_filled_columns_fit():
    run = date(2026, 10, 22)
    # FY27 run in October: amount1..4 are Jul..Oct
    assert trend_periods([0, 1, 2, 3], run) == {0: date(2026, 7, 1), 1: date(2026, 8, 1), 2: date(2026, 9, 1), 3: date(2026, 10, 1)}
    # six filled periods cannot be FY27 by October, so they are FY26 (Jan..Jun)
    assert trend_periods(list(range(6)), run)[5] == date(2026, 6, 1)
    # twelve filled periods do not fit the six-period FY26, so they are calendar 2025
    assert trend_periods(list(range(12)), run)[0] == date(2025, 1, 1)


def test_trend_income_statement_skips_the_open_month():
    parsed = Parsed(kind="income_statement")
    trend_income_statement([trend_row(70, "Revenue", False, -1, -1, -1, -1)], parsed, date(2026, 10, 22))
    assert sorted({r["period"] for r in parsed.records}) == [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    assert "October 2026 is still open" in parsed.errors[0]


def test_trend_income_statement_by_job_is_refused():
    parsed = Parsed(kind="income_statement")
    trend_income_statement([trend_row(70, "Revenue", False, -1, job="300")], parsed, date(2026, 10, 20))
    assert parsed.records == [] and "whole company" in parsed.errors[0]
