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
* Paid timekeeping (``paid_timekeeping``): the HR dashboard's daily "Paid Timekeeping" scheduled query
  (01b_paid_linked_timekeeping_daily), one row per employee, job, work date, hour category and check,
  once it carries TotalLaborDollars. Loaded as pay report labor over the work dates it carries; rows of
  checks that are not normal, posted, automatic or single-entry are skipped, the rule HR applies.
* GL Report Trend Income Statement (``trend_income_statement``): WinTeam's statement as exported, one
  row per GL line with amount1..amount12 for the fiscal year's periods and no period, account or line
  columns. Loaded as the company income statement: every GL line under ``gl:<description>`` plus the
  summary lines the allocations and views read (TREND_GROUPS). The fiscal year is the latest one
  (fiscal_year_start) whose filled periods end by the run date in the file name
  ("... - 20261020141521050.xlsx", else today); the run date's own month is still open and is skipped,
  and months whose every line is zero are left alone.

Company labels come from the company_aliases setting by name first (Sarus and Crane are separate
WinTeam databases whose company numbers overlap), then from company_numbers.
"""
from __future__ import annotations

import re
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
    if {"storedtotalhours", "workdate", "totallabordollars"} <= keys:
        return "paid_timekeeping"
    if {"glaccountdescription", "normallyadebit", "amount1", "amount12"} <= keys:
        return "trend_income_statement"
    if {"glaccountnumber", "actualdollars"} <= keys and ("periodstartdate" in keys or "fiscalperiod" in keys):
        return "job_cost_gl"
    return None


LAYOUT_KIND = {"labor_summary": "pay_report", "job_cost_gl": "job_cost", "paid_timekeeping": "pay_report",
               "trend_income_statement": "income_statement"}


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


def _tenant_company(r: Rows, aliases: dict[str, str], numbers: dict[str, str]) -> str | None:
    """Company of a paid timekeeping row. Each WinTeam database numbers its companies from 1, so the
    database name decides first: an entry in company_aliases, else any name containing "sarus" is Sarus;
    then the job's company number through company_numbers (the primary database's map)."""
    from .imports import clean_text

    tenant = clean_text(r.get("TenantDatabase"))
    if tenant and tenant in aliases:
        return aliases[tenant]
    if tenant and "sarus" in tenant.lower():
        return "Sarus"
    number = clean_text(r.get("JobCompanyNumber", "PayrollCompanyNumber"))
    return numbers.get(number.split(".")[0]) if number else None


def _paid_check(r: Rows) -> bool:
    """A normal check (status 1) in an automatic or single-entry batch (type 1 or 2) that is posted."""
    from .imports import clean_text

    status, batch = clean_text(r.get("CheckStatus")), clean_text(r.get("BatchTypeID"))
    posted = clean_text(r.get("BatchPosted"))
    return ((status is None or status.split(".")[0] == "1") and (batch is None or batch.split(".")[0] in ("1", "2"))
            and (posted is None or posted.lower() in ("1", "true")))


def paid_timekeeping(rows: list[dict[str, Any]], aliases: dict[str, str], numbers: dict[str, str], parsed: Any) -> None:
    """Append pay report records to `parsed`, one per paid row."""
    from .imports import clean_text, parse_date, parse_number

    skipped = 0
    for line, raw in enumerate(rows, start=2):
        r = Rows(raw)
        try:
            if not _paid_check(r):
                skipped += 1
                continue
            company = _tenant_company(r, aliases, numbers)
            job, employee = clean_text(r.get("JobNumber")), clean_text(r.get("EmployeeNumber"))
            if not company or not job or not employee:
                raise ValueError("company, job number or employee number is empty")
            num = lambda *names: parse_number(r.get(*names)) or Decimal(0)  # noqa: E731
            total, ot, dt = num("StoredTotalHours"), num("StoredOvertimeHours"), num("StoredDoubleTimeHours")
            ot_dollars, dt_dollars, dollars = num("OvertimeLaborDollars"), num("DoubletimeLaborDollars"), num("TotalLaborDollars")
            parsed.records.append({
                "company": company, "job_number": job, "employee_number": employee, "work_date": parse_date(r.get("WorkDate")),
                "tk_hours_id": None, "hours_type_id": clean_text(r.get("HoursTypeID")),
                "hours_type_description": clean_text(r.get("HoursTypeDescription")),
                "regular_hours": total - ot - dt, "overtime_hours": ot, "doubletime_hours": dt, "total_hours": total,
                "pay_rate": parse_number(r.get("PayRate")), "ot_rate": None, "dt_rate": None,
                "regular_dollars": dollars - ot_dollars - dt_dollars, "overtime_dollars": ot_dollars, "doubletime_dollars": dt_dollars,
                "total_dollars": dollars, "paid_by_check_id": None, "supervisor": None})
        except ValueError as exc:
            parsed.error(f"line {line}: {exc}")
    if skipped:
        parsed.error(f"{skipped} row(s) for void, replaced, unposted or manual checks were skipped")


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


# Trend Income Statement GL groups (the text before the colon in GLAccountDescription, or the whole
# description) -> summary lines. Lines below gross profit start at the first G&A group in print order.
TREND_GA_GROUPS = ("facility expense", "finance cost", "interest expense", "marketing expense", "office & other",
                   "professional fees", "support staff", "officers compensation", "vehicle expense")
TREND_GROUPS: dict[str, tuple[str, ...]] = {
    "wages": ("direct labor",),
    "payroll_taxes": ("direct production labor taxes", "fica expense", "medicare expense", "futa expense", "suta expense"),
    "workers_comp": ("operation workers comp",),
    "subcontractors": ("subcontractor",),
    "supplies": ("direct production resources", "sarus: production supplies"),
    "vehicle": ("production vehicle expenses",),
    "insurance": ("operation liability insurance",),
}
RUN_STAMP = re.compile(r"(20\d{2})(\d{2})(\d{2})\d*(?:\.\w+)?$")


# Crane's GL fiscal years: calendar years through 2025, a six-period FY26 (Jan-Jun 2026), then July to
# June from FY27. A Trend Income Statement's amount1 is the first period of the year it was run for.
FY27_START = date(2026, 7, 1)


def fiscal_year_start(month: date) -> date:
    """The first month of the GL fiscal year holding `month`."""
    if month >= FY27_START:
        return date(month.year if month.month >= 7 else month.year - 1, 7, 1)
    return date(month.year, 1, 1)


def _add_months(month: date, n: int) -> date:
    total = month.year * 12 + month.month - 1 + n
    return date(total // 12, total % 12 + 1, 1)


def trend_periods(filled: list[int], run_date: date) -> dict[int, date] | None:
    """Map the filled amount columns (0 = amount1) to months: the latest fiscal year whose filled
    periods all fall inside it and end by the run date's month. None when no fiscal year fits."""
    run_month = run_date.replace(day=1)
    start = fiscal_year_start(run_month)
    for _ in range(30):
        following = fiscal_year_start(_add_months(start, 12))
        last = _add_months(start, filled[-1])
        if last <= run_month and last < following:
            return {i: _add_months(start, i) for i in filled}
        start = fiscal_year_start(_add_months(start, -1))
    return None


def trend_run_date(file_name: str, today: date | None = None) -> date:
    """The run date in WinTeam's file name ("GL Report Trend Income Statement - 20261020141521050.xlsx")."""
    match = RUN_STAMP.search(file_name.strip())
    if match:
        try:
            return date(int(match[1]), int(match[2]), int(match[3]))
        except ValueError:
            pass
    return today or date.today()


def trend_income_statement(rows: list[dict[str, Any]], parsed: Any, run_date: date) -> None:
    """Append company income statement records (account Company, one per month and line) to `parsed`."""
    from .imports import clean_text, parse_number

    lines: list[tuple[int, str, bool, list[Decimal]]] = []
    for n, raw in enumerate(rows, start=2):
        r = Rows(raw)
        description = clean_text(r.get("GLAccountDescription"))
        if not description:
            continue
        if clean_text(r.get("jobnumber")):
            parsed.error("the statement is by job: run the Trend Income Statement for the whole company")
            return
        try:
            order = int(Decimal(str(r.get("PrintOrder") or n)))
            debit = str(r.get("NormallyADebit") or "").strip().lower() in ("true", "1", "yes")
            amounts = [parse_number(r.get(f"amount{m}")) or Decimal(0) for m in range(1, 13)]
        except (ValueError, ArithmeticError) as exc:
            parsed.error(f"line {n}: {exc}")
            continue
        # Credit lines (revenue) are negative in WinTeam; the statement keeps revenue positive.
        lines.append((order, " ".join(description.split()), debit, amounts if debit else [-a for a in amounts]))
    lines.sort(key=lambda x: x[0])
    ga_start = next((o for o, d, debit, _ in lines if debit and _group(d).startswith(TREND_GA_GROUPS)), None)
    months = [m for m in range(12) if any(a[m] for *_, a in lines)]
    if not months:
        return
    periods = trend_periods(months, run_date)
    if periods is None:
        parsed.error(f"the filled months do not fit a fiscal year ending by the run date {run_date.isoformat()}")
        return
    open_month = run_date.replace(day=1)
    if periods[months[-1]] == open_month:
        parsed.error(f"{open_month:%B %Y} is still open and was skipped")
    for m in months:
        period = periods[m]
        if period == open_month:
            continue
        summary = {k: Decimal(0) for k in ("revenue", "wages", "management_wages", "payroll_taxes", "workers_comp", "subcontractors",
                                           "supplies", "vehicle", "travel", "insurance", "gross_profit", "admin", "net_profit")}
        for order, description, debit, amounts in lines:
            amount = amounts[m]
            parsed.records.append({"account": "Company", "period": period, "line": f"gl:{description}", "amount": amount, "company": "Company"})
            if not debit:
                summary["revenue"] += amount
                continue
            if ga_start is not None and order >= ga_start:
                summary["admin"] += amount
                continue
            summary["gross_profit"] -= amount
            low = description.lower()
            key = next((k for k, groups in TREND_GROUPS.items() if low.startswith(groups)), None)
            if key:
                summary[key] += amount
            if key == "wages" and "management" in low:
                summary["management_wages"] += amount
            if "travel" in low:
                summary["travel"] += amount
        summary["gross_profit"] += summary["revenue"]
        summary["net_profit"] = summary["gross_profit"] - summary["admin"]
        parsed.records.extend({"account": "Company", "period": period, "line": k, "amount": v, "company": "Company"}
                              for k, v in summary.items())


def _group(description: str) -> str:
    return description.split(":")[0].strip().lower()
