"""The store award workbook (Apple): flat monthly revenue, not-to-exceed hours and bill rate per store.

A workbook is an award when one of its sheets has a header row (within its first ten rows) with a store number
column ("Store #") and "Revenue per Month". Every such sheet is read and a store listed twice keeps its first
row, so the All Stores tab and the per-provider tabs of the same file agree. Columns, matched ignoring case,
spaces and punctuation:

  Store #                      the store code, e.g. R550
  Revenue per Month            the flat monthly revenue, ops.job_contract.monthly_amount
  Hours per Month              the not-to-exceed hours per month, nte_hours
  Cost per Hour (Bill Rate)    bill_rate
  Effective From (optional)    when the award starts; else the job's WinTeam start date, else the upload's month

A store matches the WinTeam job whose name carries its code ("Apple - R550 - Valley Plaza", directory.split_name).
Rows upsert ops.job_contract by job and effective date, so loading a new award version replaces the amounts. The
file is logged in ops.import_file as kind 'contract'. Stores with no WinTeam job are listed as errors.
"""
from __future__ import annotations

import io
import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from .directory import split_name

HEADER_SCAN_ROWS = 10
COLUMNS = {
    "store": ("store", "storenumber", "storeno", "storeid"),
    "monthly_amount": ("revenuepermonth", "monthlyrevenue"),
    "nte_hours": ("hourspermonth", "ntehourspermonth", "ntehours"),
    "bill_rate": ("costperhourbillrate", "billrate", "costperhour"),
    "effective_from": ("effectivefrom", "effectivedate", "startdate"),
    "name": ("storename",),
}
STORE_CODE = re.compile(r"^R\d{2,4}$", re.IGNORECASE)


def compact(text: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def _columns(header: list[Any]) -> dict[str, int] | None:
    keys = [compact(h) for h in header]
    found: dict[str, int] = {}
    for field, aliases in COLUMNS.items():
        for alias in aliases:
            if alias in keys:
                found[field] = keys.index(alias)
                break
    return found if "store" in found and "monthly_amount" in found else None


def _number(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return Decimal(str(value))
    text = re.sub(r"[,$\s]", "", str(value))
    try:
        return Decimal(text) if text else None
    except ArithmeticError:
        return None


def sheets(content: bytes) -> list[list[list[Any]]]:
    from openpyxl import load_workbook

    book = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    return [[list(r) for r in sheet.iter_rows(values_only=True)] for sheet in book.worksheets]


def is_award(content: bytes) -> bool:
    try:
        return any(_columns(row) for rows in sheets(content) for row in rows[:HEADER_SCAN_ROWS])
    except Exception:  # not a workbook
        return False


def parse(sheets: list[list[list[Any]]]) -> tuple[list[dict[str, Any]], list[str], int]:
    """(stores, errors, rows read) from every award sheet; a store's first row wins."""
    stores: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    read = 0
    for rows in sheets:
        start = next((i for i, r in enumerate(rows[:HEADER_SCAN_ROWS]) if _columns(r)), None)
        if start is None:
            continue
        cols = _columns(rows[start]) or {}
        for n, row in enumerate(rows[start + 1:], start=start + 2):
            cell = lambda f: row[cols[f]] if f in cols and cols[f] < len(row) else None  # noqa: E731
            code = str(cell("store") or "").strip().upper()
            if not code:
                continue
            read += 1
            if not STORE_CODE.match(code) or code in stores:
                continue
            amount = _number(cell("monthly_amount"))
            if amount is None or amount < 0:
                errors.append(f"{code}: no revenue per month")
                continue
            start_value = cell("effective_from")
            stores[code] = {
                "store": code, "name": str(cell("name") or "").strip() or None, "monthly_amount": amount.quantize(Decimal("0.01")),
                "nte_hours": _number(cell("nte_hours")), "bill_rate": _number(cell("bill_rate")),
                "effective_from": start_value.date() if isinstance(start_value, datetime) else start_value if isinstance(start_value, date) else None,
            }
    return list(stores.values()), errors, read


JOBS_SQL = """
SELECT company, job_number, job_name, date_to_start
FROM core.dim_job
WHERE valid_to IS NULL AND company IS NOT NULL AND job_number IS NOT NULL AND job_name ~ ' - '
"""


def match(stores: list[dict[str, Any]], jobs: list[dict[str, Any]], today: date) -> tuple[list[dict[str, Any]], list[str]]:
    """Contract records for the stores with a WinTeam job (an active one first), and the codes without one."""
    by_code: dict[str, dict[str, Any]] = {}
    for job in sorted(jobs, key=lambda j: (j.get("date_to_start") is None, str(j["job_number"]))):
        code, _ = split_name(job["job_name"])
        if code and STORE_CODE.match(code):
            by_code.setdefault(code.upper(), job)
    records, missing = [], []
    for s in stores:
        job = by_code.get(s["store"])
        if job is None:
            missing.append(s["store"])
            continue
        start = s["effective_from"] or job.get("date_to_start") or today.replace(day=1)
        if isinstance(start, datetime):
            start = start.date()
        records.append({"company": job["company"], "job_number": str(job["job_number"]), "effective_from": start,
                        "period": start, "monthly_amount": s["monthly_amount"], "nte_hours": s["nte_hours"],
                        "bill_rate": s["bill_rate"], "store": s["store"]})
    return records, missing


def load(cursor: Any, records: list[dict[str, Any]], actor: str | None) -> None:
    cursor.executemany(
        """
        INSERT INTO ops.job_contract (company, job_number, effective_from, monthly_amount, nte_hours, bill_rate, note, updated_by)
        VALUES (%s, %s, %s, %s, %s, %s, 'award', %s)
        ON CONFLICT (company, job_number, effective_from) DO UPDATE
        SET monthly_amount = EXCLUDED.monthly_amount, nte_hours = EXCLUDED.nte_hours, bill_rate = EXCLUDED.bill_rate,
            note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by
        """,
        [(r["company"], r["job_number"], r["effective_from"], r["monthly_amount"], r["nte_hours"], r["bill_rate"], actor) for r in records],
    )
