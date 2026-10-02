"""Pure tests for the export-file importer (no database): header matching, feed detection, value
parsing, row normalization with line-numbered errors, XLSX reading and pay report coverage windows."""
from __future__ import annotations

import io
from datetime import date, datetime
from decimal import Decimal

import pytest
from openpyxl import Workbook

from app.imports import (coverage_windows, detect_kind, header_map, normalize_rows, parse_date, parse_number,
                         parse_period, read_table)

COMPANIES = {"1": "Crane IFS", "2": "Crane West", "3": "Crane Southwest"}

PAY_CSV = (
    "CompanyNumber,EmployeeNumber,JobNumber,WorkDate,HoursTypeID,Hours Type Description,RegularHours,OvertimeHours,"
    "DoubletimeHours,PayRate,OTRate,RegularLaborDollars,OvertimeLaborDollars,DoubletimeLaborDollars,TotalLaborDollars,PaidByCheckID,TKHoursID\n"
    "3,80175,801,09/14/2026,1,Regular,8,0,0,15.50,23.25,124.00,0,0,124.00,,5001\n"
    "3,80175,801,09/19/2026,2,Overtime,0,4,0,15.50,23.25,0,93.00,0,93.00,,5002\n"
    "3,80176,896,2026-09-20,1,Regular,6,0,0,15.10,22.65,\"$90.60\",0,0,\"$90.60\",7788,5003\n"
    "3,,801,09/15/2026,1,Regular,8,0,0,15.5,,124,0,0,124,,5004\n"
    "3,80177,802,not a date,1,Regular,8,0,0,15.5,,124,0,0,124,,5005\n"
)


def test_headers_match_case_and_punctuation_insensitively():
    m = header_map("pay_report", ["Total Labor Dollars", "work_date", "TKHoursID", "Hours Type Description"])
    assert m == {"total_dollars": "Total Labor Dollars", "work_date": "work_date", "tk_hours_id": "TKHoursID",
                 "hours_type_description": "Hours Type Description"}


@pytest.mark.parametrize("name,headers,kind", [
    ("pay_report_crane-southwest_20260921.csv", [], "pay_report"),
    ("job_cost_all_20260921.xlsx", [], "job_cost"),
    ("export.csv", ["WorkDate", "TotalLaborDollars"], "pay_report"),
    ("export.csv", ["JobNumber", "Revenue", "DirectLabor"], "job_cost"),
    ("export.csv", ["JobNumber", "Amount"], None),
])
def test_detects_the_feed(name, headers, kind):
    assert detect_kind(name, headers) == kind


def test_parses_money_dates_and_periods():
    assert parse_number("$1,234.50") == Decimal("1234.50")
    assert parse_number("(12.00)") == Decimal("-12.00")
    assert parse_number("15-") == Decimal("-15")
    assert parse_number("") is None and parse_number(None) is None
    assert parse_number(3.5) == Decimal("3.5")
    with pytest.raises(ValueError):
        parse_number("n/a")
    assert parse_date("09/14/2026") == date(2026, 9, 14)
    assert parse_date("2026-09-14T00:00:00") == date(2026, 9, 14)
    assert parse_date("9/14/2026 12:00:00 AM") == date(2026, 9, 14)
    assert parse_date(datetime(2026, 9, 14, 7)) == date(2026, 9, 14)
    assert parse_date(46279) == date(2026, 9, 14)  # Excel serial
    for value in ("2026-08", "202608", "08/2026", "8/15/2026", date(2026, 8, 31)):
        assert parse_period(value) == date(2026, 8, 1)


def test_normalizes_pay_report_rows_and_reports_bad_lines():
    headers, rows = read_table("pay_report.csv", PAY_CSV.encode())
    parsed = normalize_rows("pay_report", headers, rows, COMPANIES)
    assert parsed.rows_read == 5
    assert len(parsed.records) == 3
    assert parsed.errors == ["line 5: employee_number is empty", "line 6: not a date: 'not a date'"]
    first = parsed.records[0]
    assert first["company"] == "Crane Southwest"
    assert first["work_date"] == date(2026, 9, 14)
    assert first["total_dollars"] == Decimal("124.00")
    assert first["total_hours"] == Decimal("8")  # derived from regular + OT + DT when absent
    assert parsed.records[2]["total_dollars"] == Decimal("90.60")
    assert parsed.records[2]["paid_by_check_id"] == "7788"
    assert coverage_windows(parsed.records) == {"Crane Southwest": (date(2026, 9, 14), date(2026, 9, 20))}


def test_a_missing_required_column_fails_the_file():
    headers, rows = read_table("pay_report.csv", b"EmployeeNumber,JobNumber,WorkDate\n1,801,09/14/2026\n")
    parsed = normalize_rows("pay_report", headers, rows, COMPANIES)
    assert parsed.records == []
    assert parsed.errors == ["missing required column(s): total_dollars, company_number or company_name"]


def test_reads_the_first_sheet_of_a_workbook_below_title_rows():
    wb = Workbook()
    ws = wb.active
    ws.append([])
    ws.append(["CompanyName", "JobNumber", "Period", "Revenue", "DirectLabor", "Subcontract"])
    ws.append(["Crane Southwest", 801, "2026-08", 12642, 8791, 0])
    ws.append([None, None, None, None, None, None])
    buffer = io.BytesIO()
    wb.save(buffer)
    headers, rows = read_table("job_cost.xlsx", buffer.getvalue())
    parsed = normalize_rows("job_cost", headers, rows, COMPANIES)
    assert parsed.errors == []
    assert parsed.records == [{"company_name": "Crane Southwest", "job_number": "801", "period": date(2026, 8, 1),
                               "revenue": Decimal("12642"), "direct_labor": Decimal("8791"), "subcontractors": Decimal("0"),
                               "company": "Crane Southwest"}]


def test_income_statement_rows_normalize_lines_and_need_no_company():
    headers = ["Account", "Period", "Line", "Amount"]
    rows = [{"Account": "fedex", "Period": "2026-08", "Line": "Total Revenue", "Amount": "$1,467,246.84"},
            {"Account": "FedEx", "Period": "08/2026", "Line": "Payroll Taxes", "Amount": "46,139.28"},
            {"Account": "fedex", "Period": "2026-08", "Line": "Indstrl, Mnftng, Wrhs - Subcontracted", "Amount": "474472.50"},
            {"Account": "fedex", "Period": "2026-08", "Line": "Janitorial Bonus", "Amount": ""}]
    assert detect_kind("export.csv", headers) == "income_statement"
    assert detect_kind("income_statement_fedex_202608.csv", []) == "income_statement"
    parsed = normalize_rows("income_statement", headers, rows, {})
    assert [(r["line"], r["amount"]) for r in parsed.records] == [
        ("revenue", Decimal("1467246.84")), ("payroll_taxes", Decimal("46139.28")), ("revenue_subcontracted_gl", Decimal("474472.50"))]
    assert all(r["period"] == date(2026, 8, 1) for r in parsed.records)
    assert parsed.errors == ["line 5: amount is empty"]


def test_job_cost_reads_the_fixed_and_variable_revenue_split():
    headers = ["CompanyNumber", "JobNumber", "Period", "Revenue", "Fixed Revenue", "OS Revenue", "DirectLabor"]
    rows = [{"CompanyNumber": "2", "JobNumber": "39", "Period": "2026-08", "Revenue": "78952.73", "Fixed Revenue": "45000",
             "OS Revenue": "33952.73", "DirectLabor": "20100"}]
    record = normalize_rows("job_cost", headers, rows, COMPANIES).records[0]
    assert (record["revenue_fixed"], record["revenue_variable"]) == (Decimal("45000"), Decimal("33952.73"))


def test_job_cost_merge_accepts_overtime_hours():
    """overtime_hours is both a pay report column and an optional job cost column; merging must not add to None."""
    from app.imports import _load_job_cost

    class Cursor:
        def __init__(self):
            self.params = []
        def execute(self, sql, params=None):
            self.params.append(params)

    cursor = Cursor()
    record = {"company": "Crane West", "job_number": "39", "period": date(2026, 7, 1), "job_name": "FedEx", "revenue": Decimal(100),
              "direct_labor": Decimal(40), "overtime_hours": Decimal("3.5"), "actual_hours": Decimal(20)}
    _load_job_cost(cursor, 1, [record, {**record, "revenue": Decimal(50), "overtime_hours": Decimal("1.5")}])
    inserted = cursor.params[-1]
    assert inserted[4] == Decimal(150) and inserted[14] == Decimal(5)


TIMEKEEPING_QUERY = ["ExportRunDate", "ExportStartDate", "ExportEndDate", "TKHoursID", "JobNum", "JobDesc", "EmployeeNumber", "WorkDate", "Hours",
                     "PayRate", "HoursTypeID", "HoursTypeDescription", "RegularHours", "OvertimeHours", "DoubletimeHours", "SupervisorDescription",
                     "CompanyNumber", "CompanyName", "OTRate", "DTRate", "Dollars", "OTDollars", "DTDollars", "TotalLaborDollars", "JobNumber", "PaidByCheckID"]


def test_the_scheduled_timekeeping_query_loads_as_the_pay_report():
    """The WinTeam scheduled query (<Company>_timekeeping_recent_*.csv) as it arrives in the mailbox."""
    from app.imports import detect_kind

    values = ["9/30/2026 3:00:01 AM", "9/9/2026", "9/29/2026", "292700", "300", "Amazon - BDL3/7", "30548", "9/15/2026", "10.0000", "17.0000", "15",
              "Ops/Regular", "8.0000", "2.0000", "0.0000", "Pat Lead", "1", "ServiceMaster by Sarus Co", "25.50000", "34.00000", "136.000000",
              "51.000000", "0.000000", "187.000000", "300", "88123"]
    assert detect_kind("Sarus_timekeeping_recent_20260930_0309.csv", TIMEKEEPING_QUERY) == "pay_report"
    parsed = normalize_rows("pay_report", TIMEKEEPING_QUERY, [dict(zip(TIMEKEEPING_QUERY, values))], COMPANIES, {"ServiceMaster by Sarus Co": "Sarus"})
    r = parsed.records[0]
    assert parsed.errors == [] and r["company"] == "Sarus"  # by name: Sarus is company 1 in its own database
    assert (r["total_hours"], r["total_dollars"], r["overtime_dollars"], r["regular_dollars"]) == (Decimal("10"), Decimal("187"), Decimal("51"), Decimal("136"))
    assert r["work_date"].isoformat() == "2026-09-15" and r["paid_by_check_id"] == "88123"


def test_a_filtered_export_is_recognized_as_partial():
    """A mailed file carrying a slice of a company's jobs would replace the whole company's data."""
    from app.imports import partial_export

    class Cursor:
        def __init__(self, have): self.have = have
        def execute(self, sql, params): self.sql = sql
        def fetchone(self): return {"n": self.have}

    labor = [{"company": "Crane IFS", "job_number": str(j), "work_date": date(2026, 9, 14)} for j in range(3)]
    assert "3 jobs where 40 are loaded" in partial_export(Cursor(40), "pay_report", labor, None)
    assert partial_export(Cursor(5), "pay_report", labor, None) is None  # too little loaded to judge
    assert partial_export(Cursor(4), "pay_report", labor * 1, None) is None
    full = [{"company": "Crane IFS", "job_number": str(j), "work_date": date(2026, 9, 14)} for j in range(30)]
    assert partial_export(Cursor(40), "pay_report", full, None) is None
    cost = [{"company": "Crane West", "job_number": "39", "period": date(2026, 8, 1)}]
    assert "1 jobs where 36 are loaded for 2026-08" in partial_export(Cursor(36), "job_cost", cost, None)
