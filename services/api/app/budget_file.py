"""Labor budget workbooks that arrive by email (the reports mailbox, app/mail_inbox.py).

The same reading as Admin > Budgets (src/leadership/budgetParse.ts, ported here): each sheet is a
table; a sheet whose header row has Month and Site labor or Overhead labor is the monthly plan, one
whose header has Week ending is the weekly calendar. Columns are found by header, ignoring case,
spaces and punctuation; rows that are not a month or a date (Year, Total) are skipped.

The account comes from the file name, else the mail subject: the account whose slug or name appears
in it ("Plano_ISD_FY27_labor_budget.xlsx" is plano-isd), the longest match winning. A workbook names
one account. Months and weeks are upserted (budget.save / save_weeks); others are kept. Each file is
logged in ops.import_file as kind 'budget' (migration 051); a file already loaded is a duplicate.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from datetime import date
from typing import Any

from . import budget

KIND = "budget"
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
DETAILS = ("school_days", "staff_days", "closure_days", "summer_days", "stat_holidays")


def compact(text: str) -> str:
    return re.sub(r"[^a-z0-9%]", "", str(text).lower())


def split_table(text: str) -> list[list[str]]:
    """Rows of cells from tab- (else comma-) separated text, honoring quoted cells; blank rows dropped."""
    delimiter = "\t" if "\t" in text else ","
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    return [r for r in rows if any(c.strip() for c in r)]


def parse_month(value: str) -> str | None:
    """'Jul 2026', 'July 2026', '2026-07', '7/2026', '07/01/2026' -> '2026-07'."""
    v = value.strip().lower()
    m = re.fullmatch(r"([a-z]{3})[a-z]*\.?\s+(\d{4})", v)
    if m and m[1] in MONTHS:
        return f"{m[2]}-{MONTHS.index(m[1]) + 1:02d}"
    m = re.fullmatch(r"(\d{4})-(\d{1,2})(?:-\d{1,2})?", v)
    if m and 1 <= int(m[2]) <= 12:
        return f"{m[1]}-{int(m[2]):02d}"
    m = re.fullmatch(r"(\d{1,2})/(?:\d{1,2}/)?(\d{4})", v)
    if m and 1 <= int(m[1]) <= 12:
        return f"{m[2]}-{int(m[1]):02d}"
    return None


def parse_amount(value: str) -> float | None:
    """'$1,026,956', '(1,200)', '67.6%' -> number; '' -> None; ValueError when unreadable."""
    v = value.strip()
    if not v or v in ("-", "–"):
        return None
    negative = (v.startswith("(") and v.endswith(")")) or v.startswith("-")
    n = float(re.sub(r"[$,()%\s]", "", v).lstrip("-"))
    return -n if negative else n


def parse_day(value: str) -> str | None:
    """'2026-09-13', '9/13/2026', 'Sep 13, 2026' -> '2026-09-13'."""
    v = value.strip().lower().replace(",", "")
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", v)
    if m:
        return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}"
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", v)
    if m:
        return f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}"
    m = re.fullmatch(r"([a-z]{3})[a-z]*\.?\s+(\d{1,2})\s+(\d{4})", v)
    if m and m[1] in MONTHS:
        return f"{m[3]}-{MONTHS.index(m[1]) + 1:02d}-{int(m[2]):02d}"
    return None


def _find(header: list[str], test: Any) -> int:
    return next((i for i, h in enumerate(header) if test(h)), -1)


def _cell(cells: list[str], i: int) -> str:
    return cells[i] if 0 <= i < len(cells) else ""


def _amount(cells: list[str], i: int, label: str, name: str, errors: list[str]) -> float | None:
    try:
        n = parse_amount(_cell(cells, i)) if i >= 0 else None
    except ValueError:
        n = -1.0
    if n is not None and n < 0:
        errors.append(f'{label}: {name} "{_cell(cells, i)}" is not an amount')
        return None
    return n


def _details(cells: list[str], index: dict[str, int]) -> dict[str, float]:
    out = {}
    for key, i in index.items():
        try:
            n = parse_amount(_cell(cells, i)) if i >= 0 else None
        except ValueError:
            n = None
        if n is not None:
            out[key] = n
    return out


def parse_weeks(table: list[list[str]], at: int, errors: list[str]) -> list[dict[str, Any]]:
    header = [compact(c) for c in table[at]]
    week = _find(header, lambda h: h.startswith("weekending") or h in ("week", "weekend"))
    site = _find(header, lambda h: h.startswith("sitelabor") or h == "site")
    overhead = _find(header, lambda h: h.startswith("overhead") or h == "oh")
    holiday = _find(header, lambda h: h.startswith(("statholidaylabor", "holidaylabor", "holidaypay")) or h == "hol")
    days = {"school_days": _find(header, lambda h: h.startswith("school")), "staff_days": _find(header, lambda h: h.startswith("staff")),
            "closure_days": _find(header, lambda h: h.startswith("closure")), "summer_days": _find(header, lambda h: h.startswith("summer")),
            "stat_holidays": _find(header, lambda h: h in ("stat", "statholidays", "statdays"))}
    if site < 0 and overhead < 0:
        errors.append("No Site labor or Overhead labor column")
        return []
    out = []
    for cells in table[at + 1:]:
        label = _cell(cells, week).strip()
        day = parse_day(label)
        if not day:
            continue
        out.append({"week_end": day, "site_labor": _amount(cells, site, label, "site labor", errors) or 0,
                    "overhead_labor": _amount(cells, overhead, label, "overhead labor", errors) or 0,
                    "holiday_labor": _amount(cells, holiday, label, "stat holiday labor", errors) or 0, "details": _details(cells, days)})
    return out


def parse_months(table: list[list[str]], at: int, errors: list[str]) -> list[dict[str, Any]]:
    header = [compact(c) for c in table[at]]
    month = _find(header, lambda h: h in ("month", "period"))
    cols = {"site_labor": _find(header, lambda h: h.startswith("sitelabor")),
            "overhead_labor": _find(header, lambda h: h.startswith("overheadlabor") or h == "overhead"),
            "revenue": _find(header, lambda h: h in ("revenue", "billing") or h.startswith("revenue")),
            "supplies": _find(header, lambda h: h.startswith("supplies"))}
    total = _find(header, lambda h: h.startswith("totallabor"))
    days = {"school_days": _find(header, lambda h: h.startswith("schooldays")), "staff_days": _find(header, lambda h: h.startswith("staffdays")),
            "closure_days": _find(header, lambda h: h.startswith("closuredays")), "summer_days": _find(header, lambda h: h.startswith("summerdays")),
            "stat_holidays": _find(header, lambda h: h.startswith("statholiday"))}
    out = []
    for cells in table[at + 1:]:
        label = _cell(cells, month).strip()
        m = parse_month(label)
        if not m:
            continue
        row: dict[str, Any] = {"month": m, **{k: _amount(cells, i, label, k.replace("_", " "), errors) for k, i in cols.items()}}
        row["details"] = _details(cells, days)
        try:
            t = parse_amount(_cell(cells, total)) if total >= 0 else None
        except ValueError:
            t = None
        if t is not None and row["site_labor"] is not None and row["overhead_labor"] is not None and abs(row["site_labor"] + row["overhead_labor"] - t) > 2:
            errors.append(f"{label}: site + overhead ({row['site_labor'] + row['overhead_labor']:.2f}) does not equal total labor ({t})")
        out.append(row)
    return out


def parse_sheet(text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """(months, weeks, errors) from one sheet's text; both empty when the sheet is neither table."""
    table = split_table(text)
    errors: list[str] = []
    week_at = next((i for i, r in enumerate(table) if any(compact(c) in ("weekending", "week", "weekend") for c in r)), -1)
    if week_at >= 0:
        return [], parse_weeks(table, week_at, errors), errors
    month_at = next((i for i, r in enumerate(table) if any(compact(c) == "month" for c in r)
                     and any(compact(c).startswith(("sitelabor", "overheadlabor")) for c in r)), -1)
    if month_at >= 0:
        return parse_months(table, month_at, errors), [], errors
    return [], [], []


def sheets_of(file_name: str, content: bytes) -> list[dict[str, str]]:
    if file_name.lower().endswith((".xlsx", ".xlsm")):
        return budget.workbook_sheets(content)
    return [{"name": file_name, "text": content.decode("utf-8-sig", errors="replace")}]


def read(file_name: str, content: bytes) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Every sheet's months and weeks, with errors prefixed by sheet name."""
    months: list[dict[str, Any]] = []
    weeks: list[dict[str, Any]] = []
    errors: list[str] = []
    for sheet in sheets_of(file_name, content):
        m, w, e = parse_sheet(sheet["text"])
        months += m
        weeks += w
        errors += [f"{sheet['name']}: {x}" for x in e]
    return months, weeks, errors


def looks_like(file_name: str, content: bytes) -> bool:
    """A labor budget workbook: some sheet holds a monthly plan or a weekly calendar."""
    try:
        months, weeks, _ = read(file_name, content)
    except Exception:  # noqa: BLE001 - unreadable is simply not a budget
        return False
    return bool(months or weeks)


def account_for(accounts: list[dict[str, str]], *texts: str | None) -> str | None:
    """The account whose slug or name appears in the first text that names one; the longest match wins."""
    for text in texts:
        haystack = compact(text or "")
        hits = [(len(key), a["slug"]) for a in accounts for key in {compact(a["slug"]), compact(a["name"])} if len(key) >= 3 and key in haystack]
        if hits:
            return max(hits)[1]
    return None


def load_file(conn: Any, file_name: str, content: bytes, *, subject: str | None = None, origin: str = "mail",
              uploaded_by: str | None = None) -> dict[str, Any]:
    """Save a mailed budget workbook to the account it names; returns the ops.import_file row."""
    from .imports import _log

    digest = hashlib.sha256(content).hexdigest()
    with conn.cursor() as cursor:
        cursor.execute("SELECT 1 FROM ops.import_file WHERE kind = %s AND sha256 = %s AND status = 'loaded'", (KIND, digest))
        if cursor.fetchone():
            return _log(cursor, conn, KIND, file_name, digest, origin, "duplicate", 0, 0, [], None, None, [], uploaded_by)
        try:
            months, weeks, errors = read(file_name, content)
        except Exception as exc:  # noqa: BLE001
            return _log(cursor, conn, KIND, file_name, digest, origin, "failed", 0, 0, [], None, None,
                        [f"could not read the file: {exc.__class__.__name__}"], uploaded_by)
        cursor.execute("SELECT slug, name FROM ops.account")
        slug = account_for([dict(r) for r in cursor.fetchall()], file_name, subject)
        if slug is None:
            errors.insert(0, "no account named: put the account in the file name, e.g. plano-isd_budget.xlsx")
        if errors:
            return _log(cursor, conn, KIND, file_name, digest, origin, "failed", len(months) + len(weeks), 0, [slug] if slug else [],
                        None, None, errors[:50], uploaded_by)
        try:
            month_rows = budget.validate(months) if months else []
            week_rows = budget.validate_weeks(weeks)
        except ValueError as exc:
            return _log(cursor, conn, KIND, file_name, digest, origin, "failed", len(months) + len(weeks), 0, [slug], None, None,
                        [str(exc)], uploaded_by)
        actor = uploaded_by or origin
        budget.save(cursor, slug, month_rows, actor)
        budget.save_weeks(cursor, slug, week_rows, actor)
        span = [r["month"] for r in month_rows] + [date(r["week_end"].year, r["week_end"].month, 1) for r in week_rows]
        return _log(cursor, conn, KIND, file_name, digest, origin, "loaded", len(months) + len(weeks), len(month_rows) + len(week_rows),
                    [slug], min(span), max(span), [], uploaded_by)
