"""WinTeam report exports in their own layouts (docs/export-feeds.md), turned into the importer's records.

* Timekeeping labor summary (``labor_summary``): one row per employee, job and hours type for the
  export window, with WinTeam's own LaborDollars, OvtHrs / OvtDollars, DTHrs / DTDollars and daily
  hours in Hours1..Hours16. Loaded as pay report labor, so it replaces the estimated labor for the
  companies and days it covers. Hours1 is the window's first day. When a row's daily hours add up
  to TotalHours the row is spread over those days (dollars and OT in proportion to hours); otherwise
  the window must sit inside one Monday-Sunday week and the row lands on its first day. A window is
  covered only through the day before the export ran, so later days keep their estimate.
* Job Cost Analysis by GL line (``job_cost_gl``): one row per job, fiscal period and GL account.
  GL accounts are pivoted into the job cost columns by account ranges (JOB_COST_GL_MAP, overridable
  with ops.app_setting 'job_cost_gl_map'); 34000 OS Revenue is the variable revenue line.

Company labels come from the company_aliases setting by name first (Sarus and Crane are separate
WinTeam databases whose company numbers overlap), then from company_numbers.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Iterable

DAYS = 16
TOLERANCE = Decimal("0.1")
CENT = Decimal("0.01")

# GL account ranges -> job cost columns. Each value is a list of [low, high] ranges or single accounts.
JOB_COST_GL_MAP: dict[str, list[Any]] = {
    "revenue": [[30000, 39999]],
    "revenue_variable": [34000],
    "direct_labor": [[40000, 40999]],
    # Salaried management and supervision: a subset of direct labor, kept for the allocations view.
    "management_wages": [[40200, 40399]],
    "payroll_taxes_insurance": [[41000, 42999]],
    "other_direct_costs": [[43000, 43999], [48000, 49999]],
    "subcontractors": [[44000, 44999]],
    "materials": [[45000, 45999]],
    "equipment_supplies": [[46000, 47999]],
}


def _key(header: Any) -> str:
    return "".join(ch for ch in str(header or "").lower() if ch.isalnum())


def native_layout(headers: Iterable[Any]) -> str | None:
    keys = {_key(h) for h in headers}
    if {"exportstartdate", "labordollars", "hours1"} <= keys:
        return "labor_summary"
    if {"glaccountnumber", "actualdollars"} <= keys and ("periodstartdate" in keys or "fiscalperiod" in keys):
        return "job_cost_gl"
    return None


LAYOUT_KIND = {"labor_summary": "pay_report", "job_cost_gl": "job_cost"}


class Rows:
    """Case- and punctuation-insensitive access to one export row."""

    def __init__(self, row: dict[str, Any]):
        self.values = {_key(k): v for k, v in row.items()}

    def get(self, *names: str) -> Any:
        for name in names:
            value = self.values.get(_key(name))
            if value not in (None, ""):
                return value
        return None


def _company(r: Rows, aliases: dict[str, str], numbers: dict[str, str]) -> str | None:
    from .imports import clean_text

    name = clean_text(r.get("CompanyName"))
    if name and name in aliases:
        return aliases[name]
    number = clean_text(r.get("CompanyNumber"))
    if number and number.split(".")[0] in numbers:
        return numbers[number.split(".")[0]]
    return name


def labor_summary(rows: list[dict[str, Any]], aliases: dict[str, str], numbers: dict[str, str], parsed: Any) -> dict[str, tuple[date, date]]:
    """Append pay report records to `parsed`; returns each company's covered window."""
    from .imports import clean_text, parse_date, parse_number

    windows: dict[str, tuple[date, date]] = {}
    unsplit = 0
    for line, raw in enumerate(rows, start=2):
        r = Rows(raw)
        try:
            start, end = parse_date(r.get("ExportStartDate")), parse_date(r.get("ExportEndDate"))
            ran = r.get("ExportRunDate")
            last = min(end, parse_date(ran) - timedelta(days=1)) if ran else end
            if last < start:
                raise ValueError("the export ran before its window began")
            company = _company(r, aliases, numbers)
            job = clean_text(r.get("JobNumber", "JobNum"))
            employee = clean_text(r.get("EmployeeNumber"))
            if not company or not job or not employee:
                raise ValueError("company, job number or employee number is empty")
            num = lambda *names: parse_number(r.get(*names)) or Decimal(0)  # noqa: E731
            total_hours, dollars = num("TotalHours"), num("LaborDollars")
            ot_hours, dt_hours, ot_dollars, dt_dollars = num("OvtHrs"), num("DTHrs"), num("OvtDollars"), num("DTDollars")
            daily = [num(f"Hours{i}") for i in range(1, DAYS + 1)]
            base = {"company": company, "job_number": job, "employee_number": employee,
                    "hours_type_description": clean_text(r.get("HoursTypeDescription")), "supervisor": None,
                    "tk_hours_id": None, "hours_type_id": None, "paid_by_check_id": None, "pay_rate": None, "ot_rate": None, "dt_rate": None}

            totals = {"total_hours": total_hours, "overtime_hours": ot_hours, "doubletime_hours": dt_hours, "total_dollars": dollars,
                      "overtime_dollars": ot_dollars, "doubletime_dollars": dt_dollars}

            def spread(days: list[tuple[date, Decimal]]) -> list[dict[str, Any]]:
                """Split the row's totals over (day, hours) in proportion to hours, to the cent; the last day
                takes the rounding so the row's totals are kept exactly."""
                weight = sum(h for _, h in days)
                out = [{**base, "work_date": d, **{k: (v * h / weight).quantize(CENT) for k, v in totals.items()}} for d, h in days]
                for k, v in totals.items():
                    out[-1][k] += v - sum(o[k] for o in out)
                for o in out:
                    o["regular_hours"] = o["total_hours"] - o["overtime_hours"] - o["doubletime_hours"]
                    o["regular_dollars"] = o["total_dollars"] - o["overtime_dollars"] - o["doubletime_dollars"]
                return out

            days_in_window = (end - start).days + 1
            if total_hours > 0 and abs(sum(daily) - total_hours) <= TOLERANCE and all(h == 0 for h in daily[days_in_window:]):
                parsed.records.extend(spread([(start + timedelta(days=i), h) for i, h in enumerate(daily) if h]))
            elif start.isocalendar()[:2] == end.isocalendar()[:2]:
                if total_hours or dollars:
                    parsed.records.extend(spread([(start, Decimal(1))]))
            else:
                unsplit += 1
                raise ValueError("daily hours do not add up to TotalHours and the window spans more than one week: "
                                 "run the export for one Monday-Sunday week")
        except ValueError as exc:
            parsed.error(f"line {line}: {exc}")
            continue
        lo, hi = windows.get(company, (start, last))
        windows[company] = (min(lo, start), max(hi, last))
    if unsplit:
        # Loading the rows that did reconcile would mark the window covered with part of its labor.
        parsed.records.clear()
        parsed.errors.insert(0, f"{unsplit} row(s) cannot be split into weeks, so nothing was loaded: run the export for one Monday-Sunday week")
        return {}
    return windows


def _in(account: int, ranges: list[Any]) -> bool:
    return any((isinstance(x, list) and x[0] <= account <= x[1]) or x == account for x in ranges)


def job_cost_gl(rows: list[dict[str, Any]], aliases: dict[str, str], numbers: dict[str, str], parsed: Any,
                gl_map: dict[str, list[Any]] | None = None) -> None:
    """Append one job-cost record per company, job and month to `parsed` (GL lines summed into columns)."""
    from .imports import clean_text, parse_number, parse_period

    gl_map = gl_map or JOB_COST_GL_MAP
    merged: dict[tuple[str, str, date], dict[str, Any]] = {}
    unmapped: set[int] = set()
    for line, raw in enumerate(rows, start=2):
        r = Rows(raw)
        try:
            account_text = clean_text(r.get("GLAccountNumber"))
            if not account_text:
                continue  # subtotal rows carry no account
            account = int(Decimal(account_text))
            company = _company(r, aliases, numbers)
            job = clean_text(r.get("JobNumber"))
            if not company or not job:
                raise ValueError("company or job number is empty")
            period = r.get("PeriodStartDate")
            if period is None:
                year, month = r.get("FiscalYear"), r.get("FiscalPeriod")
                if year is None or month is None:
                    raise ValueError("no PeriodStartDate or FiscalYear / FiscalPeriod")
                period = f"{int(Decimal(str(year)))}-{int(Decimal(str(month))):02d}"
            month_start = parse_period(period)
            amount = parse_number(r.get("ActualDollars")) or Decimal(0)
        except ValueError as exc:
            parsed.error(f"line {line}: {exc}")
            continue
        rec = merged.setdefault((company, job, month_start), {
            "company": company, "job_number": job, "job_name": clean_text(r.get("JobDescription", "Jobdescription")), "period": month_start,
            **{k: Decimal(0) for k in ("revenue", "direct_labor", "payroll_taxes_insurance", "subcontractors", "materials",
                                        "equipment_supplies", "other_direct_costs")},
            "revenue_variable": None, "management_wages": None, "actual_hours": None, "overtime_hours": None,
            "total_direct_costs": None, "gross_profit": None})
        placed = False
        for column in ("revenue", "direct_labor", "payroll_taxes_insurance", "subcontractors", "materials", "equipment_supplies", "other_direct_costs"):
            if _in(account, gl_map.get(column, [])):
                rec[column] += amount
                placed = True
                break
        if not placed:
            unmapped.add(account)
            continue
        if _in(account, gl_map.get("revenue_variable", [])):
            rec["revenue_variable"] = (rec["revenue_variable"] or Decimal(0)) + amount
        if _in(account, gl_map.get("management_wages", [])) and _in(account, gl_map.get("direct_labor", [])):
            rec["management_wages"] = (rec["management_wages"] or Decimal(0)) + amount
        if _in(account, gl_map.get("direct_labor", [])):
            for field, name in (("actual_hours", "ActualHours"), ("overtime_hours", "ActualOvertimeHours")):
                value = parse_number(r.get(name))
                if value:
                    rec[field] = (rec[field] or Decimal(0)) + value
    for rec in merged.values():
        if rec["revenue_variable"] is not None:
            rec["revenue_fixed"] = rec["revenue"] - rec["revenue_variable"]
        parsed.records.append(rec)
    if unmapped:
        parsed.error(f"GL accounts outside the job cost map, not loaded: {', '.join(str(a) for a in sorted(unmapped))}")
