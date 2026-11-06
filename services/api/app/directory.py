"""The account directory: every site mapped to an account as WinTeam's job list has it, worked or not.

mart.job_week only holds sites with activity, so a contract's new sites are missing from the Sites tab until
someone punches in. Hours come from mart.v_timekeeping_effective, the same source precedence as the marts. No pay.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

WINDOW_DAYS = 28

SITES_SQL = """
SELECT j.job_key, j.company, j.job_number, j.job_name, j.address_line_1, j.address_line_2, j.city, j.state_province,
       j.postal_code, j.latitude, j.longitude, j.region_name, j.branch_name, j.manager_name, j.vertical,
       j.delivery_model, j.date_to_start, j.is_active, j.last_seen_at
FROM ops.account_job aj
JOIN core.dim_job j ON j.company = aj.company AND j.job_number = aj.job_number AND j.valid_to IS NULL
WHERE aj.account_slug = %(account)s AND aj.role = 'site'
ORDER BY j.company, j.job_number
"""

PUNCHES_SQL = f"""
SELECT t.job_key, t.company, t.employee_source_id, t.hours, t.work_date
FROM mart.v_timekeeping_effective t
WHERE t.job_key = ANY(%(jobs)s) AND t.work_date > current_date - {WINDOW_DAYS} AND t.work_date <= current_date
"""


def split_name(job_name: str | None) -> tuple[str | None, str | None]:
    """'Apple - R550 - Valley Plaza' -> ('R550', 'Valley Plaza'); 'Amazon - LGB3' -> ('LGB3', 'LGB3').
    A name without ' - ' has no code."""
    parts = [p.strip() for p in (job_name or "").split(" - ") if p.strip()]
    if not parts:
        return None, None
    if len(parts) == 1:
        return None, parts[0]
    return parts[1], " - ".join(parts[2:]) or parts[1]


def build(sites: Iterable[Mapping[str, Any]], punches: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The response without `account`: one row per site, and totals that count an employee once."""
    by_job: dict[Any, dict[str, Any]] = {}
    everyone: set[tuple[Any, Any]] = set()
    for p in punches:
        job = by_job.setdefault(p["job_key"], {"hours": 0.0, "employees": set(), "last": None})
        job["hours"] += float(p["hours"] or 0)
        if p["employee_source_id"] is not None:
            who = (p["company"], p["employee_source_id"])
            job["employees"].add(who)
            everyone.add(who)
        if job["last"] is None or p["work_date"] > job["last"]:
            job["last"] = p["work_date"]
    rows: list[dict[str, Any]] = []
    as_of = None
    for s in sites:
        work = by_job.get(s["job_key"], {"hours": 0.0, "employees": (), "last": None})
        code, name = split_name(s["job_name"])
        rows.append({
            "company": s["company"], "job_number": s["job_number"], "code": code, "name": name,
            "address_line_1": s["address_line_1"], "address_line_2": s["address_line_2"], "city": s["city"],
            "state": s["state_province"], "postal_code": s["postal_code"],
            "latitude": None if s["latitude"] is None else float(s["latitude"]),
            "longitude": None if s["longitude"] is None else float(s["longitude"]),
            "region": s["region_name"], "market": s["branch_name"], "manager": s["manager_name"], "service_tier": s["vertical"],
            "delivery": s["delivery_model"], "start_date": s["date_to_start"], "active": bool(s["is_active"]),
            "hours_28d": round(work["hours"], 2), "employees_28d": len(work["employees"]), "last_punch": work["last"],
        })
        if s["last_seen_at"] is not None and (as_of is None or s["last_seen_at"] > as_of):
            as_of = s["last_seen_at"]
    count = lambda test: sum(1 for r in rows if test(r))  # noqa: E731
    return {
        "as_of": as_of, "sites": rows,
        "totals": {
            "sites": len(rows), "active": count(lambda r: r["active"]),
            "self_perform": count(lambda r: r["delivery"] == "self_perform"),
            "subcontracted": count(lambda r: r["delivery"] == "subcontracted"),
            "unassigned": count(lambda r: r["delivery"] is None),
            "working": count(lambda r: r["hours_28d"] != 0 or r["last_punch"] is not None),
            "hours_28d": round(sum(r["hours_28d"] for r in rows), 2), "employees_28d": len(everyone),
        },
    }


def report(cursor: Any, account: str) -> dict[str, Any]:
    cursor.execute(SITES_SQL, {"account": account})
    sites = cursor.fetchall()
    cursor.execute(PUNCHES_SQL, {"jobs": [s["job_key"] for s in sites]})
    return build(sites, cursor.fetchall())
