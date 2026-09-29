"""WinTeam report exports imported as files (migration 029, docs/export-feeds.md).

Two feeds, CSV (UTF-8, header row) or XLSX (first sheet):

* `pay_report` - Pay Report Timekeeping, one row per employee, job, work date and hours type, with
  full pay dollars. A file replaces its companies' rows over the work dates it covers and records the
  window in core.pay_report_coverage.
* `job_cost` - Job Cost Analysis by job and month. Rows are written with source 'export_import',
  which mart.v_job_cost_month_effective prefers over the restored finance_reference export. Optional
  revenue_fixed / revenue_variable columns split revenue into contract billing and variable (OS,
  pallet) billing for the Pallet view.
* `income_statement` - Trend Income Statement lines by account and month (account, period, line,
  amount). A file replaces its accounts' months. Lines are normalized to IS_LINES keys. Account
  "Company" (or All, Total, Crane IFS) is the company-wide statement behind the allocations.

Headers are matched case- and punctuation-insensitively against the WinTeam column names in
FIELD_ALIASES, so "TotalLaborDollars", "Total Labor Dollars" and "total_labor_dollars" are the same
column. Files are logged in ops.import_file by SHA-256; a file already loaded is reported as a
duplicate and not loaded again. Nothing here reads or writes WinTeam.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import re
import shutil
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

from . import native_exports

logger = logging.getLogger(__name__)

KINDS = ("pay_report", "job_cost", "income_statement")
# Income statement Account values that mean the company-wide statement (allocations, Company view).
COMPANY_SCOPE = "__company__"
COMPANY_WORDS = {"company", "all", "total", "crane ifs", "all companies", "consolidated"}

FIELD_ALIASES: dict[str, dict[str, tuple[str, ...]]] = {
    "pay_report": {
        "company_number": ("companynumber", "companyno"),
        "company_name": ("companyname", "company"),
        "employee_number": ("employeenumber", "employeeno", "empno", "employeeid"),
        "job_number": ("jobnumber", "jobno"),
        "work_date": ("workdate", "date"),
        "tk_hours_id": ("tkhoursid", "timekeepingid"),
        "hours_type_id": ("hourstypeid",),
        "hours_type_description": ("hourstypedescription", "hourstype"),
        "regular_hours": ("regularhours", "reghours"),
        "overtime_hours": ("overtimehours", "othours"),
        "doubletime_hours": ("doubletimehours", "dthours"),
        "total_hours": ("totalhours", "hours"),
        "pay_rate": ("payrate", "rate"),
        "ot_rate": ("otrate", "overtimerate"),
        "dt_rate": ("dtrate", "doubletimerate"),
        "regular_dollars": ("regularlabordollars", "regulardollars"),
        "overtime_dollars": ("overtimelabordollars", "otdollars", "overtimedollars"),
        "doubletime_dollars": ("doubletimelabordollars", "dtdollars", "doubletimedollars"),
        "total_dollars": ("totallabordollars", "totaldollars", "dollars"),
        "paid_by_check_id": ("paidbycheckid",),
        "supervisor": ("supervisordescription", "supervisor"),
    },
    "job_cost": {
        "company_number": ("companynumber", "companyno"),
        "company_name": ("companyname", "company"),
        "job_number": ("jobnumber", "jobno"),
        "job_name": ("jobdescription", "jobname"),
        "period": ("period", "periodid", "month", "fiscalperiod"),
        "revenue": ("revenue", "income"),
        "direct_labor": ("directlabor", "labor"),
        "payroll_taxes_insurance": ("payrolltaxesinsurance", "payrolltaxesandinsurance", "payrolltaxes"),
        "subcontractors": ("subcontract", "subcontractors", "subcontractor"),
        "materials": ("supplies", "materials"),
        "equipment_supplies": ("equipmentsupplies", "equipment"),
        "other_direct_costs": ("otherdirect", "otherdirectcosts"),
        "total_direct_costs": ("totaldirectcosts", "directcosts"),
        "gross_profit": ("grossprofit",),
        "actual_hours": ("actualhours",),
        "overtime_hours": ("overtimehours", "othours"),
        "revenue_fixed": ("revenuefixed", "fixedrevenue", "contractrevenue", "fixedbilling", "fixedinvoice"),
        "revenue_variable": ("revenuevariable", "variablerevenue", "osrevenue", "extrawork", "variablebilling", "variableinvoice"),
    },
    "income_statement": {
        "account": ("account", "accountslug", "accountname", "book"),
        "period": ("period", "periodid", "month", "fiscalperiod"),
        "line": ("line", "linename", "lineitem", "description", "accountdescription", "glaccountdescription"),
        "amount": ("amount", "total", "value", "actual"),
    },
}
# Trend Income Statement lines -> the keys the Income Statement view reads. Other lines are kept under
# their compacted name.
IS_LINES: dict[str, tuple[str, ...]] = {
    "revenue": ("revenue", "totalrevenue", "income", "totalincome", "sales"),
    "revenue_subcontracted_gl": ("revenuesubcontractedgl", "subcontractedrevenue", "indstrlmnftngwrhssubcontracted"),
    "wages": ("wages", "directwages", "directlabor", "salariesandwages", "salarieswages"),
    "management_wages": ("managementwages", "mgmtwages", "management"),
    "payroll_taxes": ("payrolltaxes", "payrolltaxesinsurance", "payrolltaxesandinsurance", "taxes"),
    "workers_comp": ("workerscomp", "workerscompensation"),
    "subcontractors": ("subcontractors", "subcontract", "subcontractorcost", "subcontractorexpense"),
    "supplies": ("supplies", "suppliesequipment", "equipmentsupplies"),
    "vehicle": ("vehicle", "vehicleexpense", "auto"),
    "travel": ("travel", "travelexpense"),
    "insurance": ("insurance",),
    "gross_profit": ("grossprofit",),
    "admin": ("admin", "administrative", "generaladministrative", "gaexpense"),
    "net_profit": ("netprofit", "netincome"),
}


def is_line_key(label: Any) -> str:
    key = compact(label)
    return next((k for k, aliases in IS_LINES.items() if key in aliases), key)
REQUIRED: dict[str, tuple[str, ...]] = {
    "pay_report": ("employee_number", "job_number", "work_date", "total_dollars"),
    "job_cost": ("job_number", "period", "revenue"),
    "income_statement": ("account", "period", "line", "amount"),
}
MAX_ERRORS = 50


def compact(header: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(header or "").lower())


def header_map(kind: str, headers: Iterable[Any]) -> dict[str, str]:
    """Canonical field -> the file's header, first alias wins."""
    by_compact = {compact(h): str(h) for h in headers if h is not None}
    mapping: dict[str, str] = {}
    for fieldname, aliases in FIELD_ALIASES[kind].items():
        for alias in aliases:
            if alias in by_compact:
                mapping[fieldname] = by_compact[alias]
                break
    return mapping


def detect_kind(file_name: str, headers: Iterable[Any]) -> str | None:
    name = file_name.lower()
    for kind in KINDS:
        if name.startswith(kind):
            return kind
    keys = {compact(h) for h in headers}
    if {"totallabordollars", "workdate"} <= keys or {"totaldollars", "workdate"} <= keys:
        return "pay_report"
    if "revenue" in keys and ("directlabor" in keys or "grossprofit" in keys):
        return "job_cost"
    if {"line", "amount"} <= keys or {"linename", "amount"} <= keys:
        return "income_statement"
    return None


def read_table(file_name: str, content: bytes) -> tuple[list[str], list[dict[str, Any]]]:
    """Headers and rows of a CSV or the first sheet of an XLSX. Blank rows are skipped."""
    if file_name.lower().endswith((".xlsx", ".xlsm")):
        from openpyxl import load_workbook

        sheet = load_workbook(io.BytesIO(content), read_only=True, data_only=True).worksheets[0]
        rows = [list(r) for r in sheet.iter_rows(values_only=True)]
        start = next((i for i, r in enumerate(rows) if any(v not in (None, "") for v in r)), None)
        if start is None:
            return [], []
        headers = [str(h).strip() if h is not None else "" for h in rows[start]]
        body = [dict(zip(headers, r)) for r in rows[start + 1:] if any(v not in (None, "") for v in r)]
        return headers, body
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip() for h in (reader.fieldnames or [])]
    reader.fieldnames = headers
    return headers, [r for r in reader if any((v or "").strip() for v in r.values() if isinstance(v, str))]


def parse_number(value: Any) -> Decimal | None:
    """"$1,234.50", "(12.00)" (negative), "", None, and numbers from XLSX cells."""
    if value is None:
        return None
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        return Decimal(str(value))
    text = str(value).strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[,$\s()]", "", text)
    if cleaned.endswith("-"):
        negative, cleaned = True, cleaned[:-1]
    try:
        number = Decimal(cleaned)
    except InvalidOperation:
        raise ValueError(f"not a number: {text!r}") from None
    return -number if negative else number


def parse_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return date(1899, 12, 30) + timedelta(days=int(value))  # Excel serial day
    text = str(value or "").strip()
    day = text.split("T")[0].split(" ")[0]  # "8/1/2026 12:00:00 AM", "2026-08-01T00:00:00"
    for pattern in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(day, pattern).date()
        except ValueError:
            continue
    raise ValueError(f"not a date: {text!r}")


def parse_period(value: Any) -> date:
    """"2026-08", "2026-08-01", "202608", "08/2026", "8/1/2026", or a date cell -> first of the month."""
    if isinstance(value, (date, datetime)):
        d = value.date() if isinstance(value, datetime) else value
        return d.replace(day=1)
    text = str(value or "").strip()
    if re.fullmatch(r"\d{6}", text):
        return date(int(text[:4]), int(text[4:]), 1)
    match = re.fullmatch(r"(\d{4})-(\d{1,2})", text) or None
    if match:
        return date(int(match[1]), int(match[2]), 1)
    match = re.fullmatch(r"(\d{1,2})/(\d{4})", text)
    if match:
        return date(int(match[2]), int(match[1]), 1)
    return parse_date(text).replace(day=1)


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    return text or None


def company_label(record: dict[str, Any], company_numbers: dict[str, str]) -> str | None:
    """The company label the warehouse uses: the company_numbers setting for a number, else the name."""
    number = clean_text(record.get("company_number"))
    if number is not None:
        label = company_numbers.get(number.split(".")[0])
        if label:
            return label
    return clean_text(record.get("company_name"))


@dataclass
class Parsed:
    kind: str
    records: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    rows_read: int = 0

    def error(self, message: str) -> None:
        if len(self.errors) < MAX_ERRORS:
            self.errors.append(message)


def normalize_rows(kind: str, headers: list[str], rows: list[dict[str, Any]], company_numbers: dict[str, str]) -> Parsed:
    """Rows -> canonical records. A row with a bad value is skipped and reported by its line number
    (header = line 1); a file missing a required column fails as a whole."""
    parsed = Parsed(kind=kind, rows_read=len(rows))
    mapping = header_map(kind, headers)
    missing = [f for f in REQUIRED[kind] if f not in mapping]
    if kind != "income_statement" and "company_number" not in mapping and "company_name" not in mapping:
        missing.append("company_number or company_name")
    if missing:
        parsed.error(f"missing required column(s): {', '.join(missing)}")
        return parsed
    numeric = {"regular_hours", "overtime_hours", "doubletime_hours", "total_hours", "pay_rate", "ot_rate", "dt_rate",
               "regular_dollars", "overtime_dollars", "doubletime_dollars", "total_dollars", "revenue", "direct_labor",
               "payroll_taxes_insurance", "subcontractors", "materials", "equipment_supplies", "other_direct_costs",
               "total_direct_costs", "gross_profit", "actual_hours", "revenue_fixed", "revenue_variable", "amount"}
    for line, row in enumerate(rows, start=2):
        raw = {f: row.get(h) for f, h in mapping.items()}
        try:
            record: dict[str, Any] = {}
            for f, v in raw.items():
                if f in numeric:
                    record[f] = parse_number(v)
                elif f == "work_date":
                    record[f] = parse_date(v)
                elif f == "period":
                    record[f] = parse_period(v)
                else:
                    record[f] = clean_text(v)
            record["company"] = company_label(record, company_numbers) if kind != "income_statement" else record.get("account")
            for f in REQUIRED[kind]:
                if record.get(f) in (None, ""):
                    raise ValueError(f"{f} is empty")
            if not record["company"]:
                raise ValueError("company is empty")
            if kind == "income_statement":
                record["line"] = is_line_key(record["line"])
        except ValueError as exc:
            parsed.error(f"line {line}: {exc}")
            continue
        if kind == "pay_report":
            hours = [record.get(k) or Decimal(0) for k in ("regular_hours", "overtime_hours", "doubletime_hours")]
            if record.get("total_hours") is None:
                record["total_hours"] = sum(hours)
        parsed.records.append(record)
    return parsed


PAY_COLUMNS = ("company", "employee_number", "job_number", "work_date", "tk_hours_id", "hours_type_id", "hours_type_description",
               "regular_hours", "overtime_hours", "doubletime_hours", "total_hours", "pay_rate", "ot_rate", "dt_rate",
               "regular_dollars", "overtime_dollars", "doubletime_dollars", "total_dollars", "paid_by_check_id", "supervisor")
ZERO_DEFAULT = {"regular_hours", "overtime_hours", "doubletime_hours", "total_hours", "regular_dollars", "overtime_dollars",
                "doubletime_dollars", "total_dollars", "revenue", "direct_labor", "payroll_taxes_insurance", "subcontractors",
                "materials", "equipment_supplies", "other_direct_costs", "total_direct_costs", "gross_profit"}


def coverage_windows(records: list[dict[str, Any]]) -> dict[str, tuple[date, date]]:
    """Per company, the first and last work date the file carries."""
    windows: dict[str, tuple[date, date]] = {}
    for r in records:
        lo, hi = windows.get(r["company"], (r["work_date"], r["work_date"]))
        windows[r["company"]] = (min(lo, r["work_date"]), max(hi, r["work_date"]))
    return windows


def _load_pay_report(cursor: Any, file_id: int, records: list[dict[str, Any]],
                     windows: dict[str, tuple[date, date]] | None = None) -> None:
    """Replace each company's pay report rows over its window: the file's work dates, or the export
    window a native labor summary states (days nobody worked are covered too)."""
    for company, (lo, hi) in (windows or coverage_windows(records)).items():
        cursor.execute("DELETE FROM core.fact_pay_report WHERE company = %s AND work_date BETWEEN %s AND %s", (company, lo, hi))
        cursor.execute("INSERT INTO core.pay_report_coverage (company, date_from, date_to, import_file_id) VALUES (%s, %s, %s, %s)",
                       (company, lo, hi, file_id))
    placeholders = ", ".join(["%s"] * (len(PAY_COLUMNS) + 1))
    cursor.executemany(
        f"INSERT INTO core.fact_pay_report (import_file_id, {', '.join(PAY_COLUMNS)}) VALUES ({placeholders})",
        [(file_id, *[(r.get(c) if r.get(c) is not None else (Decimal(0) if c in ZERO_DEFAULT else None)) for c in PAY_COLUMNS])
         for r in records],
    )


def _load_job_cost(cursor: Any, file_id: int, records: list[dict[str, Any]], replace_months: bool = False) -> None:
    """Upsert job-months. With replace_months (a full Job Cost Analysis by GL line), the imported rows of
    each company and month in the file are cleared first, so a job that left the report leaves the data."""
    if replace_months:
        for company, month in {(r["company"], r["period"]) for r in records}:
            cursor.execute("DELETE FROM core.fact_job_cost_month WHERE source = 'export_import' AND company = %s AND month = %s", (company, month))
    merged: dict[tuple[str, date], dict[str, Any]] = {}
    for r in records:  # a file may split one job-month over several rows
        key = (r["job_number"], r["period"])
        acc = merged.setdefault(key, {**{k: Decimal(0) for k in ZERO_DEFAULT}, "job_name": r.get("job_name"), "company": r["company"],
                                      "actual_hours": None, "overtime_hours": None, "revenue_fixed": None, "revenue_variable": None,
                                      "management_wages": None})
        nullable = ("actual_hours", "overtime_hours", "revenue_fixed", "revenue_variable", "management_wages")
        for k in ZERO_DEFAULT:
            if k in r and r[k] is not None and k not in nullable:
                acc[k] += r[k]
        for k in nullable:
            if r.get(k) is not None:
                acc[k] = (acc[k] or Decimal(0)) + r[k]
    for (job_number, month), r in merged.items():
        direct = r["total_direct_costs"] or (r["direct_labor"] + r["payroll_taxes_insurance"] + r["subcontractors"] + r["materials"]
                                             + r["equipment_supplies"] + r["other_direct_costs"])
        gross = r["gross_profit"] or (r["revenue"] - direct)
        cursor.execute(
            """
            INSERT INTO core.fact_job_cost_month (source, job_number, month, job_name, company, revenue, direct_labor,
              payroll_taxes_insurance, materials, subcontractors, equipment_supplies, other_direct_costs, total_direct_costs,
              gross_profit, actual_hours, overtime_hours, revenue_fixed, revenue_variable, management_wages, lineage, warehouse_loaded_at)
            VALUES ('export_import', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (source, job_number, month) DO UPDATE SET
              job_name = EXCLUDED.job_name, company = EXCLUDED.company, revenue = EXCLUDED.revenue,
              direct_labor = EXCLUDED.direct_labor, payroll_taxes_insurance = EXCLUDED.payroll_taxes_insurance,
              materials = EXCLUDED.materials, subcontractors = EXCLUDED.subcontractors,
              equipment_supplies = EXCLUDED.equipment_supplies, other_direct_costs = EXCLUDED.other_direct_costs,
              total_direct_costs = EXCLUDED.total_direct_costs, gross_profit = EXCLUDED.gross_profit,
              actual_hours = EXCLUDED.actual_hours, overtime_hours = EXCLUDED.overtime_hours,
              revenue_fixed = EXCLUDED.revenue_fixed, revenue_variable = EXCLUDED.revenue_variable,
              management_wages = EXCLUDED.management_wages, lineage = EXCLUDED.lineage, warehouse_loaded_at = now()
            """,
            (job_number, month, r["job_name"], r["company"], r["revenue"], r["direct_labor"], r["payroll_taxes_insurance"],
             r["materials"], r["subcontractors"], r["equipment_supplies"], r["other_direct_costs"], direct, gross,
             r["actual_hours"], r["overtime_hours"], r["revenue_fixed"], r["revenue_variable"], r["management_wages"],
             json.dumps({"import_file_id": file_id})),
        )


def _account_slugs(cursor: Any) -> dict[str, str]:
    """Slug or name (case-insensitive) -> slug."""
    cursor.execute("SELECT slug, name FROM ops.account")
    out: dict[str, str] = {}
    for r in cursor.fetchall():
        out[r["slug"].lower()] = r["slug"]
        out[r["name"].lower()] = r["slug"]
    return out


def _load_income_statement(cursor: Any, file_id: int, records: list[dict[str, Any]]) -> None:
    """Replace the (account, month) lines the file covers; repeated lines in a month are summed."""
    totals: dict[tuple[str, date, str], Decimal] = {}
    for r in records:  # accounts were resolved to slugs in load_file
        key = (r["account"], r["period"], r["line"])
        totals[key] = totals.get(key, Decimal(0)) + r["amount"]
    for slug, month in {(k[0], k[1]) for k in totals}:
        if slug == COMPANY_SCOPE:
            cursor.execute("DELETE FROM core.fact_company_income_statement_month WHERE month = %s", (month,))
        else:
            cursor.execute("DELETE FROM core.fact_income_statement_month WHERE account_slug = %s AND month = %s", (slug, month))
    cursor.executemany(
        "INSERT INTO core.fact_income_statement_month (account_slug, month, line, amount, import_file_id) VALUES (%s, %s, %s, %s, %s)",
        [(slug, month, line, amount, file_id) for (slug, month, line), amount in totals.items() if slug != COMPANY_SCOPE],
    )
    cursor.executemany(
        "INSERT INTO core.fact_company_income_statement_month (month, line, amount, import_file_id) VALUES (%s, %s, %s, %s)",
        [(month, line, amount, file_id) for (slug, month, line), amount in totals.items() if slug == COMPANY_SCOPE],
    )


def _company_aliases(cursor: Any) -> dict[str, str]:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'company_aliases'")
    row = cursor.fetchone()
    value = row["value"] if row else None
    return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}


def _gl_map(cursor: Any) -> dict[str, list[Any]] | None:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'job_cost_gl_map'")
    row = cursor.fetchone()
    return row["value"] if row and isinstance(row["value"], dict) else None


def _company_numbers(cursor: Any) -> dict[str, str]:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'company_numbers'")
    row = cursor.fetchone()
    value = row["value"] if row else None
    return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}


def load_file(conn: Any, file_name: str, content: bytes, *, kind: str | None = None, origin: str = "upload",
              uploaded_by: str | None = None) -> dict[str, Any]:
    """Parse, validate and load one export file in one transaction. Returns the ops.import_file row as a dict."""
    digest = hashlib.sha256(content).hexdigest()
    with conn.cursor() as cursor:
        try:
            headers, rows = read_table(file_name, content)
        except Exception as exc:  # unreadable workbook / encoding: logged, not raised
            headers, rows = [], []
            read_error = f"could not read the file: {exc.__class__.__name__}"
        else:
            read_error = None
        layout = native_exports.native_layout(headers)
        if layout and kind not in (None, native_exports.LAYOUT_KIND[layout]):
            layout = None
        kind = native_exports.LAYOUT_KIND[layout] if layout else (kind or detect_kind(file_name, headers))
        if kind not in KINDS:
            errors = [read_error or "unknown feed: name the file pay_report_*, job_cost_* or income_statement_*, or use the documented column names"]
            return _log(cursor, conn, kind or "pay_report", file_name, digest, origin, "failed", len(rows), 0, [], None, None, errors, uploaded_by)
        cursor.execute("SELECT import_file_id FROM ops.import_file WHERE kind = %s AND sha256 = %s AND status = 'loaded'", (kind, digest))
        if cursor.fetchone():
            return _log(cursor, conn, kind, file_name, digest, origin, "duplicate", len(rows), 0, [], None, None, [], uploaded_by)
        windows = None
        if layout:
            parsed = Parsed(kind=kind, rows_read=len(rows))
            if layout == "labor_summary":
                windows = native_exports.labor_summary(rows, _company_aliases(cursor), _company_numbers(cursor), parsed)
            else:
                native_exports.job_cost_gl(rows, _company_aliases(cursor), _company_numbers(cursor), parsed, _gl_map(cursor))
        else:
            parsed = normalize_rows(kind, headers, rows, _company_numbers(cursor))
        if kind == "income_statement":
            slugs, known = _account_slugs(cursor), []
            for r in parsed.records:
                label = str(r["account"]).strip().lower()
                slug = COMPANY_SCOPE if label in COMPANY_WORDS else slugs.get(label)
                if slug is None:
                    parsed.error(f"unknown account {r['account']!r}: use an account slug or name")
                else:
                    known.append({**r, "account": slug, "company": slug})
            parsed.records = known
        if read_error:
            parsed.errors.insert(0, read_error)
        if not parsed.records:
            return _log(cursor, conn, kind, file_name, digest, origin, "failed", parsed.rows_read, 0, [], None, None,
                        parsed.errors or ["no rows"], uploaded_by)
        dates = [r["work_date"] if kind == "pay_report" else r["period"] for r in parsed.records]
        companies = sorted({r["company"] for r in parsed.records})
        result = _log(cursor, None, kind, file_name, digest, origin, "loaded", parsed.rows_read, len(parsed.records), companies,
                      min(dates), max(dates), parsed.errors, uploaded_by)
        if kind == "pay_report":
            _load_pay_report(cursor, result["import_file_id"], parsed.records, windows)
        elif kind == "income_statement":
            _load_income_statement(cursor, result["import_file_id"], parsed.records)
        else:
            _load_job_cost(cursor, result["import_file_id"], parsed.records, replace_months=layout == "job_cost_gl")
    conn.commit()
    logger.info("Imported %s %s: %s of %s rows", kind, file_name, result["rows_loaded"], result["rows_read"])
    return result


def _log(cursor: Any, conn: Any, kind: str, file_name: str, digest: str, origin: str, status: str, rows_read: int,
         rows_loaded: int, companies: list[str], period_from: date | None, period_to: date | None, errors: list[str],
         uploaded_by: str | None) -> dict[str, Any]:
    cursor.execute(
        """
        INSERT INTO ops.import_file (kind, file_name, sha256, origin, status, rows_read, rows_loaded, companies,
                                     period_from, period_to, errors, uploaded_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING import_file_id, kind, file_name, origin, status, rows_read, rows_loaded, companies, period_from, period_to,
                  errors, uploaded_by, loaded_at
        """,
        (kind, file_name, digest, origin, status, rows_read, rows_loaded, companies, period_from, period_to,
         json.dumps(errors), uploaded_by),
    )
    row = dict(cursor.fetchone())
    if conn is not None:
        conn.commit()
    return row


def scan_inbox(conn: Any, inbox: Path) -> list[dict[str, Any]]:
    """Load every file in the inbox (oldest first) and move it to processed/ or failed/."""
    if not inbox.is_dir():
        return []
    results = []
    files = sorted((p for p in inbox.iterdir() if p.is_file() and p.suffix.lower() in (".csv", ".xlsx", ".xlsm")),
                   key=lambda p: p.stat().st_mtime)
    for path in files:
        try:
            result = load_file(conn, path.name, path.read_bytes(), origin="inbox", uploaded_by="inbox")
        except Exception:
            conn.rollback()
            logger.exception("Import of %s failed", path.name)
            result = {"file_name": path.name, "status": "failed", "errors": ["load failed; see the API log"]}
        target = inbox / ("failed" if result["status"] == "failed" else "processed")
        target.mkdir(exist_ok=True)
        shutil.move(str(path), str(target / path.name))
        results.append(result)
    return results
