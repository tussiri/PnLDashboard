"""WinTeam report exports imported as files (migration 029, docs/export-feeds.md).

Two feeds, CSV (UTF-8, header row) or XLSX (first sheet):

* `pay_report` - Pay Report Timekeeping, one row per employee, job, work date and hours type, with
  full pay dollars. A file replaces its companies' rows over the work dates it covers and records the
  window in core.pay_report_coverage.
* `job_cost` - Job Cost Analysis by job and month. Rows are written with source 'export_import',
  which mart.v_job_cost_month_effective prefers over the restored finance_reference export.

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

logger = logging.getLogger(__name__)

KINDS = ("pay_report", "job_cost")

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
    },
}
REQUIRED: dict[str, tuple[str, ...]] = {
    "pay_report": ("employee_number", "job_number", "work_date", "total_dollars"),
    "job_cost": ("job_number", "period", "revenue"),
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
    if "company_number" not in mapping and "company_name" not in mapping:
        missing.append("company_number or company_name")
    if missing:
        parsed.error(f"missing required column(s): {', '.join(missing)}")
        return parsed
    numeric = {"regular_hours", "overtime_hours", "doubletime_hours", "total_hours", "pay_rate", "ot_rate", "dt_rate",
               "regular_dollars", "overtime_dollars", "doubletime_dollars", "total_dollars", "revenue", "direct_labor",
               "payroll_taxes_insurance", "subcontractors", "materials", "equipment_supplies", "other_direct_costs",
               "total_direct_costs", "gross_profit", "actual_hours"}
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
            record["company"] = company_label(record, company_numbers)
            for f in REQUIRED[kind]:
                if record.get(f) in (None, ""):
                    raise ValueError(f"{f} is empty")
            if not record["company"]:
                raise ValueError("company is empty")
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


def _load_pay_report(cursor: Any, file_id: int, records: list[dict[str, Any]]) -> None:
    for company, (lo, hi) in coverage_windows(records).items():
        cursor.execute("DELETE FROM core.fact_pay_report WHERE company = %s AND work_date BETWEEN %s AND %s", (company, lo, hi))
        cursor.execute("INSERT INTO core.pay_report_coverage (company, date_from, date_to, import_file_id) VALUES (%s, %s, %s, %s)",
                       (company, lo, hi, file_id))
    placeholders = ", ".join(["%s"] * (len(PAY_COLUMNS) + 1))
    cursor.executemany(
        f"INSERT INTO core.fact_pay_report (import_file_id, {', '.join(PAY_COLUMNS)}) VALUES ({placeholders})",
        [(file_id, *[(r.get(c) if r.get(c) is not None else (Decimal(0) if c in ZERO_DEFAULT else None)) for c in PAY_COLUMNS])
         for r in records],
    )


def _load_job_cost(cursor: Any, file_id: int, records: list[dict[str, Any]]) -> None:
    merged: dict[tuple[str, date], dict[str, Any]] = {}
    for r in records:  # a file may split one job-month over several rows
        key = (r["job_number"], r["period"])
        acc = merged.setdefault(key, {**{k: Decimal(0) for k in ZERO_DEFAULT}, "job_name": r.get("job_name"), "company": r["company"],
                                      "actual_hours": None, "overtime_hours": None})
        for k in ZERO_DEFAULT:
            if k in r and r[k] is not None:
                acc[k] += r[k]
        for k in ("actual_hours", "overtime_hours"):
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
              gross_profit, actual_hours, overtime_hours, lineage, warehouse_loaded_at)
            VALUES ('export_import', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (source, job_number, month) DO UPDATE SET
              job_name = EXCLUDED.job_name, company = EXCLUDED.company, revenue = EXCLUDED.revenue,
              direct_labor = EXCLUDED.direct_labor, payroll_taxes_insurance = EXCLUDED.payroll_taxes_insurance,
              materials = EXCLUDED.materials, subcontractors = EXCLUDED.subcontractors,
              equipment_supplies = EXCLUDED.equipment_supplies, other_direct_costs = EXCLUDED.other_direct_costs,
              total_direct_costs = EXCLUDED.total_direct_costs, gross_profit = EXCLUDED.gross_profit,
              actual_hours = EXCLUDED.actual_hours, overtime_hours = EXCLUDED.overtime_hours,
              lineage = EXCLUDED.lineage, warehouse_loaded_at = now()
            """,
            (job_number, month, r["job_name"], r["company"], r["revenue"], r["direct_labor"], r["payroll_taxes_insurance"],
             r["materials"], r["subcontractors"], r["equipment_supplies"], r["other_direct_costs"], direct, gross,
             r["actual_hours"], r["overtime_hours"], json.dumps({"import_file_id": file_id})),
        )


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
        kind = kind or detect_kind(file_name, headers)
        if kind not in KINDS:
            errors = [read_error or "unknown feed: name the file pay_report_* or job_cost_*, or use the documented column names"]
            return _log(cursor, conn, kind or "pay_report", file_name, digest, origin, "failed", len(rows), 0, [], None, None, errors, uploaded_by)
        cursor.execute("SELECT import_file_id FROM ops.import_file WHERE kind = %s AND sha256 = %s AND status = 'loaded'", (kind, digest))
        if cursor.fetchone():
            return _log(cursor, conn, kind, file_name, digest, origin, "duplicate", len(rows), 0, [], None, None, [], uploaded_by)
        parsed = normalize_rows(kind, headers, rows, _company_numbers(cursor))
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
            _load_pay_report(cursor, result["import_file_id"], parsed.records)
        else:
            _load_job_cost(cursor, result["import_file_id"], parsed.records)
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
