"""The labor hours report: every punch at the sites of the configured states, by employee.

Reads mart.v_timekeeping_effective (the same source precedence as the marts), never WinTeam directly, so
it is as fresh as the last timekeeping sync. Hours only: pay rates and labor dollars stay out of the
response on purpose. Zero and negative hours are WinTeam's own adjustments and stay in, so totals match it.

Settings (ops.app_setting, migration 063)
    labor_report_states           the dim_job.state_province values in scope. 'CA' here is California:
                                  dim_job.country_code 'CA' is Canada and is not read.
    timekeeping_category_labels   hours type names of the API's categoryDetailId values
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, timedelta
from typing import Any

from .sources.rules import namespace_for

MAX_DAYS = 92

SQL = """
SELECT t.company, t.employee_source_id, t.work_date, t.hours, t.lunch, t.hours_type, t.category_detail_id,
       to_char(t.in_time AT TIME ZONE 'UTC', 'HH24:MI') AS in_time,
       to_char(t.out_time AT TIME ZONE 'UTC', 'HH24:MI') AS out_time,
       j.company AS job_company, j.job_number, j.job_name, j.city, j.state_province
FROM mart.v_timekeeping_effective t
JOIN core.dim_job j ON j.job_key = t.job_key AND j.valid_to IS NULL
WHERE upper(j.state_province) = ANY(%(states)s)
  AND t.work_date BETWEEN %(date_from)s AND %(date_to)s
  AND t.employee_source_id IS NOT NULL
  AND (%(accounts)s::text[] IS NULL OR EXISTS (
    SELECT 1 FROM ops.account_job aj
    WHERE aj.company = j.company AND aj.job_number = j.job_number AND aj.account_slug = ANY(%(accounts)s)))
ORDER BY t.company, t.employee_source_id, t.work_date, t.in_time NULLS LAST, t.timekeeping_key
"""

# The API carries no names. HrDashboard's are current; the export's punches fill in the rest, and an
# employee in neither has none.
HR_NAMES_SQL = """
SELECT winteam_company, employee_number, last_name, first_name, title
FROM core.hr_employee_name
WHERE employee_number = ANY(%(employees)s)
"""

EXPORT_NAMES_SQL = """
SELECT DISTINCT ON (company, employee_source_id) company, employee_source_id, employee_name
FROM core.fact_timekeeping
WHERE employee_name IS NOT NULL AND employee_source_id = ANY(%(employees)s)
ORDER BY company, employee_source_id, work_date DESC
"""


def full_name(first: str, last: str) -> str:
    """As the export writes them: 'Last, First'."""
    return ", ".join(part for part in (last, first) if part)


def names_for(rows: Iterable[Mapping[str, Any]], hr: Mapping[tuple[str, str], str], export: Mapping[tuple[str | None, str], str]) -> dict[tuple[str | None, str], str]:
    """Each punch employee's name, HrDashboard's first. HR keys by WinTeam database, the punches by company within it."""
    out: dict[tuple[str | None, str], str] = {}
    for who in {(r["company"], r["employee_source_id"]) for r in rows}:
        name = hr.get((namespace_for(who[0]), who[1])) or export.get(who)
        if name:
            out[who] = name
    return out


def titles_for(rows: Iterable[Mapping[str, Any]], hr: Mapping[tuple[str, str], str]) -> dict[tuple[str | None, str], str]:
    """Each punch employee's job title from HrDashboard, keyed as `names_for` keys names."""
    out: dict[tuple[str | None, str], str] = {}
    for who in {(r["company"], r["employee_source_id"]) for r in rows}:
        title = hr.get((namespace_for(who[0]), who[1]))
        if title:
            out[who] = title
    return out


def default_range(today: date) -> tuple[date, date]:
    """The last complete Monday-Sunday week."""
    date_to = today - timedelta(days=today.weekday() + 1)
    return date_to - timedelta(days=6), date_to


def validate_range(date_from: date, date_to: date) -> None:
    if date_from > date_to:
        raise ValueError("date_from must not be after date_to")
    if (date_to - date_from).days >= MAX_DAYS:
        raise ValueError(f"The period may not be longer than {MAX_DAYS} days")


def states_setting(value: Any) -> list[str]:
    return [str(s).strip().upper() for s in value if str(s).strip()] if isinstance(value, list) else []


def hours_type(row: Mapping[str, Any], labels: Mapping[str, str]) -> str | None:
    if row.get("hours_type"):
        return row["hours_type"]
    category = row.get("category_detail_id")
    return None if category is None else labels.get(str(category), f"Type {category}")


def _hours(value: Any) -> float:
    return round(float(value or 0), 2)


def build(rows: Iterable[Mapping[str, Any]], names: Mapping[tuple[str | None, str], str], labels: Mapping[str, str],
          date_from: date, date_to: date, states: list[str],
          titles: Mapping[tuple[str | None, str], str] | None = None) -> dict[str, Any]:
    """The response of GET /labor-hours from the punch rows, in employee and work date order."""
    employees: dict[tuple[str | None, str], dict[str, Any]] = {}
    sites: dict[tuple[str | None, str], dict[str, Any]] = {}
    for r in rows:
        who = (r["company"], r["employee_source_id"])
        site_id = (r["job_company"], r["job_number"])
        employee = employees.setdefault(who, {
            "company": r["company"], "employee_number": r["employee_source_id"], "employee_name": names.get(who),
            "title": (titles or {}).get(who), "hours": 0.0, "lunch_hours": 0.0, "days": set(), "site_ids": set(), "punches": []})
        site = sites.setdefault(site_id, {
            "company": r["job_company"], "job_number": r["job_number"], "site_name": r["job_name"], "city": r["city"],
            "state": r["state_province"], "hours": 0.0, "employee_ids": set(), "punches": 0})
        employee["hours"] += _hours(r["hours"])
        employee["lunch_hours"] += _hours(r["lunch"])
        employee["days"].add(r["work_date"])
        employee["site_ids"].add(site_id)
        employee["punches"].append({
            "work_date": r["work_date"].isoformat(), "company": r["job_company"], "job_number": r["job_number"], "site_name": r["job_name"],
            "hours_type": hours_type(r, labels), "in_time": r["in_time"], "out_time": r["out_time"],
            "lunch_hours": _hours(r["lunch"]), "hours": _hours(r["hours"])})
        site["hours"] += _hours(r["hours"])
        site["employee_ids"].add(who)
        site["punches"] += 1
    employee_out = [{
        "company": e["company"], "employee_number": e["employee_number"], "employee_name": e["employee_name"], "title": e["title"],
        "sites": len(e["site_ids"]), "days": len(e["days"]), "hours": round(e["hours"], 2), "lunch_hours": round(e["lunch_hours"], 2),
        "punches": e["punches"]} for e in employees.values()]
    site_out = [{
        "company": s["company"], "job_number": s["job_number"], "site_name": s["site_name"], "city": s["city"], "state": s["state"],
        "employees": len(s["employee_ids"]), "punches": s["punches"], "hours": round(s["hours"], 2)} for s in sites.values()]
    punches = [p for e in employee_out for p in e["punches"]]
    return {
        "date_from": date_from.isoformat(), "date_to": date_to.isoformat(), "states": states,
        "through": max((p["work_date"] for p in punches), default=None),
        "totals": {"employees": len(employee_out), "sites": len(site_out), "punches": len(punches), "hours": round(sum(e["hours"] for e in employee_out), 2)},
        "sites": site_out, "employees": employee_out,
    }


def report(cursor: Any, date_from: date, date_to: date, accounts: frozenset[str] | None) -> dict[str, Any]:
    """`accounts` limits the sites for a user limited to some accounts; None covers them all."""
    cursor.execute("SELECT key, value FROM ops.app_setting WHERE key IN ('labor_report_states', 'timekeeping_category_labels')")
    settings = {r["key"]: r["value"] for r in cursor.fetchall()}
    states = states_setting(settings.get("labor_report_states"))
    labels = settings.get("timekeeping_category_labels") or {}
    cursor.execute(SQL, {"states": states, "date_from": date_from, "date_to": date_to, "accounts": sorted(accounts) if accounts is not None else None})
    rows = cursor.fetchall()
    employees = sorted({r["employee_source_id"] for r in rows})
    cursor.execute(HR_NAMES_SQL, {"employees": employees})
    held = cursor.fetchall()
    hr = {(r["winteam_company"], r["employee_number"]): full_name(r["first_name"], r["last_name"]) for r in held}
    hr_titles = {(r["winteam_company"], r["employee_number"]): r["title"] for r in held if r.get("title")}
    cursor.execute(EXPORT_NAMES_SQL, {"employees": employees})
    export = {(r["company"], r["employee_source_id"]): r["employee_name"] for r in cursor.fetchall()}
    return build(rows, names_for(rows, hr, export), labels, date_from, date_to, states, titles_for(rows, hr_titles))
