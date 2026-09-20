"""Labor routes: /labor/summary (mart.job_month + mart.v_timekeeping_effective) and /labor/pace.

Definitions (disclosed here and in docs/forecasting.md):

- labor_cost = mart.job_month.labor_cost: timekeeping hours x rate for the WinTeam API source; for the
  finance reference source the job-cost P&L direct labor (closed months) or hours x the job's trailing
  closed-month rate (in-progress months). Burden / payroll T&I is excluded. The active definition is
  returned in `definitions.labor_cost`.
- labor_pct_revenue = labor_cost / revenue; target_labor_pct = ops.app_setting labor_target_pct.
- overtime_cost_estimate = sum(overtime_hours) x average hourly rate x 0.5. It is an ESTIMATE
  of the overtime premium: the average rate is labor_cost / hours for the selection, and the
  0.5 premium assumes time-and-a-half. The WinTeam timekeeping feed does not carry the paid
  premium itself.
- monthly always covers the trailing 12 months ending at the anchor month so trend charts stay
  stable while the period selector changes the KPI window (same convention as /portfolio).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query

from ..common import (MartFilters, MonthRange, add_months, jsonable, month_end, parse_month,
                      range_block, read_setting, resolve_filters, resolve_request_range,
                      scope_block, source_block)
from ..db import connection
from ..pace import month_pace

router = APIRouter()

OVERTIME_PREMIUM = 0.5


LABOR_COST_DEFINITIONS = {
    "winteam_api": "timekeeping hours x rate, before burden",
    "finance_reference": "job-cost P&L direct labor for months with a closed job-cost import; timekeeping hours x the job's "
                         "trailing closed-month rate (direct_labor / actual_hours) for in-progress months; before payroll T&I",
}


def labor_cost_definition(primary_source: str | None) -> str:
    """Disclosed labor_cost basis for the source that filled the marts."""
    return LABOR_COST_DEFINITIONS.get(primary_source or "", LABOR_COST_DEFINITIONS["winteam_api"])


def _ratio(num: float | None, den: float | None) -> float | None:
    if num is None or not den:
        return None
    return round(float(num) / float(den), 4)


def _f(value: Any) -> float:
    return float(value or 0)


@router.get("/labor/summary")
def labor_summary(rng: MonthRange = Depends(resolve_request_range),
                  filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    clause, params = filters.clause("jm")
    range_params = [rng.start, rng.end, *params]
    trailing_start = add_months(rng.anchor, -11)

    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT sum(jm.labor_cost) AS labor_cost, sum(jm.revenue) AS revenue,
                   sum(jm.gross_profit) AS gross_profit, sum(jm.hours) AS hours,
                   sum(jm.overtime_hours) AS overtime_hours, sum(jm.scheduled_hours) AS scheduled_hours,
                   sum(jm.budget_labor) AS budget_labor,
                   count(*) FILTER (WHERE jm.budget_labor IS NOT NULL) AS budget_rows
            FROM mart.job_month jm
            WHERE jm.month BETWEEN %s AND %s{clause}
            """,
            range_params,
        )
        k = cursor.fetchone() or {}

        cursor.execute(
            f"""
            SELECT jm.month, sum(jm.labor_cost) AS labor_cost, sum(jm.budget_labor) AS budget_labor,
                   sum(jm.revenue) AS revenue, sum(jm.hours) AS hours,
                   sum(jm.overtime_hours) AS overtime_hours, sum(jm.scheduled_hours) AS scheduled_hours
            FROM mart.job_month jm
            WHERE jm.month BETWEEN %s AND %s{clause}
            GROUP BY jm.month ORDER BY jm.month
            """,
            [trailing_start, rng.anchor, *params],
        )
        monthly = [{
            "month": r["month"].isoformat(),
            "labor_cost": _f(r["labor_cost"]),
            "budget_labor": jsonable(r["budget_labor"]),
            "revenue": _f(r["revenue"]),
            "labor_pct_revenue": _ratio(r["labor_cost"], r["revenue"]),
            "hours": _f(r["hours"]),
            "overtime_hours": _f(r["overtime_hours"]),
            "scheduled_hours": _f(r["scheduled_hours"]),
        } for r in cursor.fetchall()]

        cursor.execute(
            f"""
            SELECT coalesce(jm.parent_account, 'Unassigned') AS parent_account,
                   sum(jm.labor_cost) AS labor_cost, sum(jm.budget_labor) AS budget_labor,
                   sum(jm.revenue) AS revenue, sum(jm.hours) AS hours, sum(jm.overtime_hours) AS overtime_hours
            FROM mart.job_month jm
            WHERE jm.month BETWEEN %s AND %s{clause}
            GROUP BY 1 ORDER BY sum(jm.labor_cost) DESC
            """,
            range_params,
        )
        by_account = [{
            "parent_account": r["parent_account"],
            "labor_cost": _f(r["labor_cost"]),
            "budget_labor": jsonable(r["budget_labor"]),
            "revenue": _f(r["revenue"]),
            "hours": _f(r["hours"]),
            "overtime_hours": _f(r["overtime_hours"]),
            "labor_pct_revenue": _ratio(r["labor_cost"], r["revenue"]),
        } for r in cursor.fetchall()]

        cursor.execute(
            f"""
            SELECT jm.job_number, max(jm.job_name) AS job_name, max(jm.parent_account) AS parent_account,
                   sum(jm.labor_cost) AS labor_cost, sum(jm.budget_labor) AS budget_labor,
                   sum(jm.hours) AS hours, sum(jm.overtime_hours) AS overtime_hours,
                   sum(jm.scheduled_hours) AS scheduled_hours
            FROM mart.job_month jm
            WHERE jm.month BETWEEN %s AND %s{clause}
            GROUP BY jm.job_number ORDER BY sum(jm.labor_cost) DESC
            """,
            range_params,
        )
        by_job = []
        for r in cursor.fetchall():
            budget = jsonable(r["budget_labor"])
            by_job.append({
                "job_number": r["job_number"],
                "job_name": r["job_name"],
                "parent_account": r["parent_account"],
                "labor_cost": _f(r["labor_cost"]),
                "budget_labor": budget,
                "labor_variance": round(_f(r["labor_cost"]) - budget, 2) if budget is not None else None,
                "hours": _f(r["hours"]),
                "overtime_hours": _f(r["overtime_hours"]),
                "overtime_pct": _ratio(r["overtime_hours"], r["hours"]),
                "scheduled_hours": _f(r["scheduled_hours"]),
            })

        # Timekeeping is punch-grained, so the scope reaches it through the job numbers the mart
        # selects (the default key-account scope always narrows, so this is the normal path).
        job_scope = ""
        job_params: list[Any] = []
        if clause:
            job_scope = (f" AND t.job_number IN (SELECT DISTINCT jm.job_number FROM mart.job_month jm "
                         f"WHERE jm.month BETWEEN %s AND %s{clause})")
            job_params = range_params
        cursor.execute(
            f"""
            SELECT t.employee_source_id,
                   sum(coalesce(t.hours, coalesce(t.regular_hours, 0) + coalesce(t.overtime_hours, 0))) AS hours,
                   sum(coalesce(t.overtime_hours, 0)) AS overtime_hours,
                   count(DISTINCT t.job_number) AS jobs
            FROM mart.v_timekeeping_effective t
            WHERE t.work_date BETWEEN %s AND %s{job_scope}
            GROUP BY t.employee_source_id
            HAVING sum(coalesce(t.overtime_hours, 0)) > 0
            ORDER BY sum(coalesce(t.overtime_hours, 0)) DESC
            LIMIT 25
            """,
            [rng.start, month_end(rng.end), *job_params],
        )
        overtime_employees = [{
            "employee_source_id": r["employee_source_id"],
            "hours": _f(r["hours"]),
            "overtime_hours": _f(r["overtime_hours"]),
            "jobs": int(r["jobs"] or 0),
        } for r in cursor.fetchall()]

    labor_cost = _f(k.get("labor_cost"))
    revenue = _f(k.get("revenue"))
    hours = _f(k.get("hours"))
    overtime_hours = _f(k.get("overtime_hours"))
    scheduled_hours = _f(k.get("scheduled_hours"))
    budget_labor = jsonable(k.get("budget_labor")) if (k.get("budget_rows") or 0) > 0 else None
    avg_rate = labor_cost / hours if hours > 0 else 0.0
    target = read_setting("labor_target_pct", 0.47)
    try:
        target_pct = float(target)
    except (TypeError, ValueError):
        target_pct = 0.47

    kpis = {
        "labor_cost": round(labor_cost, 2),
        "revenue": round(revenue, 2),
        "labor_pct_revenue": _ratio(labor_cost, revenue),
        "target_labor_pct": target_pct,
        "hours": round(hours, 2),
        "overtime_hours": round(overtime_hours, 2),
        "overtime_pct": _ratio(overtime_hours, hours),
        "overtime_cost_estimate": round(overtime_hours * avg_rate * OVERTIME_PREMIUM, 2),
        "budget_labor": budget_labor,
        "labor_variance": round(labor_cost - budget_labor, 2) if budget_labor is not None else None,
        "scheduled_hours": round(scheduled_hours, 2),
        "hours_variance": round(hours - scheduled_hours, 2),
        "revenue_per_hour": round(revenue / hours, 2) if hours > 0 else None,
        "gross_profit_per_hour": round(_f(k.get("gross_profit")) / hours, 2) if hours > 0 else None,
    }
    source = source_block()
    return {
        "source": source,
        "range": range_block(rng, filters),
        "filters": filters.active(),
        "scope_note": f"{filters.label}: {int(rng.months)} month(s) to {rng.end.isoformat()}.",
        "definitions": {
            "overtime_cost_estimate": f"overtime_hours x (labor_cost / hours) x {OVERTIME_PREMIUM} premium; "
                                      "an estimate, the feed does not carry the paid premium",
            "labor_cost": labor_cost_definition(source.get("primary_source")),
        },
        "kpis": kpis,
        "monthly": monthly,
        "by_account": by_account,
        "by_job": by_job,
        "overtime_employees": overtime_employees,
    }


@router.get("/labor/pace")
def labor_pace(month: str | None = Query(None), account: str | None = Query(None),
               job_number: str | None = Query(None), as_of: str | None = Query(None)) -> dict[str, Any]:
    """Month-end labor projection. Its own scope is the (portfolio | account | job) row set the pace
    model builds, so `scope` here only echoes what `account` / `job_number` selected - the
    key-account scope does not apply to the portfolio row, which stays company-wide."""
    as_of_date: date | None = None
    if as_of:
        as_of_date = date.fromisoformat(as_of[:10])
    result = month_pace(parse_month(month), account or None, job_number or None, as_of_date)
    scope_filters = MartFilters(account=account or None, job_number=job_number or None, scope="all")
    return {"source": source_block(), **result, "scope": scope_block(scope_filters)}
