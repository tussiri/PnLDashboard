"""Reporting routes over the mart tables (docs/api-contract.md, "Reporting" section).

Every response carries `source` (live/empty disclosure) and `range` (resolved month range). All
aggregation happens in SQL; Python only applies the disclosed status rule and shapes the payload.

Status rule (thresholds read from ops.app_setting.margin_target_pct):
  Critical when gross margin < target - 7 pts, labor over budget by > 13 %, overtime > 15 % of
  hours, or open-balance-weighted AR days > 65. Watch at margin < target, labor over budget > 7 %,
  overtime > 10 %, AR days > 45. Otherwise Healthy.

Derived values disclosed here:
  * AR open balance = invoiceTotal - amountPaid (mart.v_ar_open, on mart.v_ar_invoice_effective: an API
    invoice supersedes the export invoice with the same customer / invoice number - migration 011). With the finance reference source
    amountPaid is derived from the latest AR aging snapshot, /ar/aging reads that snapshot directly
    (WinTeam aging groups as buckets, `as_of` = snapshot date) and `collectible_open` excludes the
    customers matched by the ar_treatment_rules setting.
  * AP open balance: null for the WinTeam API source (payments are not invoice-linked); the real open
    balance of the latest AP vendor aging snapshot for the finance reference source.
  * DSO = ar_open / (trailing 3-month revenue / 91), null when that revenue is 0.
  * Budget variance lines compare actuals only for (job, month) rows that carry the matching budget
    line, so `coverage` shows how much of the portfolio is budgeted. The gross-profit budget is
    budget_revenue - budget_direct_cost (job-cost budget) else budget_revenue - the GL budget classes.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query

from ..common import (
    SCOPE_ALL,
    MartFilters,
    MonthRange,
    add_months,
    envelope,
    job_scope_subquery,
    jsonable,
    latest_mart_month,
    month_end,
    month_start,
    range_block,
    read_settings,
    resolve_filters,
    resolve_range,
    resolve_request_range,
    scope_block,
    source_block,
)
from ..db import connection

logger = logging.getLogger("reporting")
router = APIRouter()

DEFAULT_MARGIN_TARGET = 0.25
DEFAULT_LABOR_TARGET = 0.47

JOB_DIMS_SQL = """
  SELECT j.job_key, j.job_number, j.job_name, pa.account_name AS parent_account,
         j.region_name AS region, j.branch_name AS branch, j.service_type, j.vertical, j.manager_name,
         j.city, j.state_province, j.country_code, j.latitude, j.longitude, j.is_active, j.date_to_start,
         j.company, j.delivery_model, j.geo_precision
  FROM core.dim_job j
  LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
  WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL
"""

JOB_ROWS_SQL = f"""
WITH dims AS ({JOB_DIMS_SQL}),
agg AS (
  SELECT jm.job_key,
         max(jm.customer_number) AS customer_number,
         sum(jm.revenue) AS revenue, sum(jm.invoiced_total) AS invoiced_total, sum(jm.collected_total) AS collected_total,
         sum(jm.gross_profit) AS gross_profit, sum(jm.labor_cost) AS labor_cost, sum(jm.burden_cost) AS burden_cost,
         sum(jm.hours) AS hours, sum(jm.regular_hours) AS regular_hours, sum(jm.overtime_hours) AS overtime_hours,
         sum(jm.scheduled_hours) AS scheduled_hours, sum(jm.budget_revenue) AS budget_revenue, sum(jm.budget_labor) AS budget_labor,
         sum(jm.payroll_ti_cost) AS payroll_ti_cost, sum(jm.subcontract_cost) AS subcontract_cost, sum(jm.supplies_cost) AS supplies_cost,
         sum(jm.other_direct_cost) AS other_direct_cost, sum(jm.direct_cost) AS direct_cost,
         max(jm.last_work_date) AS last_work_date, count(*) AS months_reporting
  FROM mart.job_month jm
  WHERE jm.month BETWEEN %s AND %s {{filters}}
  GROUP BY jm.job_key
),
emp AS (
  SELECT d.job_key, count(DISTINCT t.employee_source_id) AS employee_count
  FROM mart.v_timekeeping_effective t JOIN dims d ON d.job_number = t.job_number
  WHERE t.work_date BETWEEN %s AND %s
  GROUP BY d.job_key
),
ar AS (
  SELECT d.job_key, sum(o.open_balance) AS ar_open,
         sum(o.open_balance * o.days_outstanding) / nullif(sum(o.open_balance), 0) AS days_outstanding_weighted,
         bool_and(coalesce(i.is_collectible, true)) AS collectible_only
  FROM mart.v_ar_open o
  JOIN dims d ON d.job_number = o.job_number
  LEFT JOIN core.fact_ar_invoice i ON i.ar_invoice_key = o.ar_invoice_key
  GROUP BY d.job_key
),
inv AS (
  SELECT d.job_key, max(i.invoice_date) AS last_invoice_date
  FROM mart.v_ar_invoice_effective i JOIN dims d ON d.job_number = i.job_number
  GROUP BY d.job_key
)
SELECT d.job_key, d.job_number, d.job_name, d.parent_account, a.customer_number, d.region, d.branch, d.service_type,
       d.vertical, d.manager_name, d.city, d.state_province, d.country_code, d.latitude, d.longitude, d.is_active,
       d.date_to_start, a.revenue, a.invoiced_total, a.collected_total, a.gross_profit, a.labor_cost, a.burden_cost,
       a.hours, a.regular_hours, a.overtime_hours, a.scheduled_hours, a.budget_revenue, a.budget_labor,
       coalesce(emp.employee_count, 0) AS employee_count, coalesce(ar.ar_open, 0) AS ar_open,
       ar.days_outstanding_weighted, inv.last_invoice_date, a.last_work_date, a.months_reporting,
       d.company, d.delivery_model, d.geo_precision, a.payroll_ti_cost, a.subcontract_cost, a.supplies_cost, a.other_direct_cost,
       a.direct_cost, coalesce(ar.collectible_only, true) AS is_collectible_ar_only
FROM agg a
JOIN dims d ON d.job_key = a.job_key
LEFT JOIN emp ON emp.job_key = a.job_key
LEFT JOIN ar ON ar.job_key = a.job_key
LEFT JOIN inv ON inv.job_key = a.job_key
ORDER BY a.revenue DESC, d.job_number
"""

TOTALS_SQL = """
SELECT coalesce(sum(jm.revenue), 0) AS revenue,
       coalesce(sum(jm.invoiced_total), 0) AS invoiced_total,
       coalesce(sum(jm.collected_total), 0) AS collected_total,
       coalesce(sum(jm.gross_profit), 0) AS gross_profit,
       coalesce(sum(jm.labor_cost), 0) AS labor_cost,
       coalesce(sum(jm.burden_cost), 0) AS burden_cost,
       coalesce(sum(jm.hours), 0) AS hours,
       coalesce(sum(jm.regular_hours), 0) AS regular_hours,
       coalesce(sum(jm.overtime_hours), 0) AS overtime_hours,
       coalesce(sum(jm.scheduled_hours), 0) AS scheduled_hours,
       sum(jm.budget_revenue) AS budget_revenue,
       sum(jm.budget_labor) AS budget_labor,
       sum(jm.budget_subcontract) AS budget_subcontract,
       sum(jm.budget_supplies) AS budget_supplies,
       coalesce(sum(jm.payroll_ti_cost), 0) AS payroll_ti_cost,
       coalesce(sum(jm.subcontract_cost), 0) AS subcontract_cost,
       coalesce(sum(jm.supplies_cost), 0) AS supplies_cost,
       coalesce(sum(jm.other_direct_cost), 0) AS other_direct_cost,
       coalesce(sum(jm.direct_cost), 0) AS direct_cost,
       count(DISTINCT jm.job_key) AS jobs,
       count(DISTINCT jm.job_key) FILTER (WHERE j.is_active) AS active_jobs
FROM mart.job_month jm
JOIN core.dim_job j ON j.job_key = jm.job_key
WHERE jm.month BETWEEN %s AND %s {filters}
"""


# ── small helpers ────────────────────────────────────────────────────────────
def f(value: Any) -> float | None:
    return None if value is None else float(value)


def f0(value: Any) -> float:
    return 0.0 if value is None else float(value)


def ratio(numerator: Any, denominator: Any, digits: int = 4) -> float | None:
    if denominator in (None, 0) or numerator is None:
        return None
    return round(float(numerator) / float(denominator), digits)


def pct_change(current: Any, prior: Any) -> float | None:
    if prior in (None, 0) or current is None:
        return None
    return round((float(current) - float(prior)) / abs(float(prior)), 4)


def pts_delta(current: float | None, prior: float | None) -> float | None:
    if current is None or prior is None:
        return None
    return round(current - prior, 4)


def targets() -> tuple[float, float]:
    values = read_settings()
    try:
        margin = float(values.get("margin_target_pct", DEFAULT_MARGIN_TARGET))
    except (TypeError, ValueError):
        margin = DEFAULT_MARGIN_TARGET
    try:
        labor = float(values.get("labor_target_pct", DEFAULT_LABOR_TARGET))
    except (TypeError, ValueError):
        labor = DEFAULT_LABOR_TARGET
    return margin, labor


def range_dates(rng: MonthRange) -> tuple[date, date]:
    return rng.start, month_end(rng.end)


# `envelope(rng, filters)` (source + range + range.scope) lives in app/common.py so every router
# assembles the same head; `range_block` is the range half for the responses that build their own.


# ── status rule ──────────────────────────────────────────────────────────────
def evaluate(row: dict[str, Any], margin_target: float) -> list[dict[str, Any]]:
    """Alerts for one job/account aggregate; the status is derived from the worst severity."""
    alerts: list[dict[str, Any]] = []
    revenue = f0(row.get("revenue"))
    margin = f0(row.get("gross_profit")) / revenue if revenue > 0 else None
    # A margin outside +/-200 % is a broken denominator, not performance: a site billed $4.9K
    # carrying $338K of labor posts -6,785 %. Firing "critical" on those made 371 of 526 sites
    # Critical - 70 % of the portfolio - which trains a reader to ignore the badge entirely. The
    # site still appears and still reports its other alerts; only the margin test is withheld, and
    # `margin_not_meaningful` says so instead of leaving the omission silent.
    # The upper bound matters too: a facilities site always carries labor or subcontract cost, so a
    # margin at or above 99.5 % is cost that never landed, not an excellent site. (Server margins are
    # fractions; the browser applies the same two bounds in utils.ts.)
    margin_meaningful = margin is not None and abs(margin) <= 2.0 and margin < 0.995
    if margin is not None and not margin_meaningful:
        alerts.append(_alert("margin_not_meaningful", "info",
                             f"Gross margin is not meaningful ({margin:.0%}); revenue or cost is incomplete for this period",
                             margin, 2.0))
    if margin_meaningful:
        if margin < margin_target - 0.07:
            alerts.append(_alert("margin", "critical", f"Gross margin {margin:.1%} is more than 7 pts below the {margin_target:.0%} target", margin, margin_target - 0.07))
        elif margin < margin_target:
            alerts.append(_alert("margin", "watch", f"Gross margin {margin:.1%} is below the {margin_target:.0%} target", margin, margin_target))
    budget_labor = f(row.get("budget_labor"))
    if budget_labor and budget_labor > 0:
        over = (f0(row.get("labor_cost")) - budget_labor) / budget_labor
        if over > 0.13:
            alerts.append(_alert("labor_budget", "critical", f"Labor is {over:.1%} over budget", over, 0.13))
        elif over > 0.07:
            alerts.append(_alert("labor_budget", "watch", f"Labor is {over:.1%} over budget", over, 0.07))
    hours = f0(row.get("hours"))
    if hours > 0:
        overtime = f0(row.get("overtime_hours")) / hours
        if overtime > 0.15:
            alerts.append(_alert("overtime", "critical", f"Overtime is {overtime:.1%} of hours", overtime, 0.15))
        elif overtime > 0.10:
            alerts.append(_alert("overtime", "watch", f"Overtime is {overtime:.1%} of hours", overtime, 0.10))
    days = f(row.get("days_outstanding_weighted"))
    if days is not None:
        if days > 65:
            alerts.append(_alert("ar_aging", "critical", f"Open receivables average {days:.0f} days outstanding", days, 65))
        elif days > 45:
            alerts.append(_alert("ar_aging", "watch", f"Open receivables average {days:.0f} days outstanding", days, 45))
    return alerts


def _alert(kind: str, severity: str, detail: str, value: float, threshold: float) -> dict[str, Any]:
    return {"type": kind, "severity": severity, "detail": detail, "metric_value": round(value, 4), "threshold": threshold}


def status_from(alerts: list[dict[str, Any]]) -> str:
    """Worst severity wins. `info` alerts are disclosures, not findings, and never set a status."""
    if any(a["severity"] == "critical" for a in alerts):
        return "Critical"
    if any(a["severity"] == "watch" for a in alerts):
        return "Watch"
    return "Healthy"


def job_row(row: dict[str, Any], margin_target: float) -> dict[str, Any]:
    alerts = evaluate(row, margin_target)
    revenue = f0(row.get("revenue"))
    budget_labor = f(row.get("budget_labor"))
    labor_cost = f0(row.get("labor_cost"))
    return {
        "job_key": row["job_key"],
        "job_number": row["job_number"],
        "job_name": row.get("job_name"),
        "parent_account": row.get("parent_account"),
        "customer_number": row.get("customer_number"),
        "region": row.get("region"),
        "branch": row.get("branch"),
        "service_type": row.get("service_type"),
        "vertical": row.get("vertical"),
        "manager_name": row.get("manager_name"),
        "city": row.get("city"),
        "state_province": row.get("state_province"),
        "country_code": row.get("country_code"),
        "latitude": f(row.get("latitude")),
        "longitude": f(row.get("longitude")),
        "is_active": bool(row.get("is_active", True)),
        "date_to_start": jsonable(row.get("date_to_start")),
        "revenue": revenue,
        "invoiced_total": f0(row.get("invoiced_total")),
        "collected_total": f0(row.get("collected_total")),
        "gross_profit": f0(row.get("gross_profit")),
        "gross_margin_pct": ratio(row.get("gross_profit"), revenue if revenue > 0 else None),
        "labor_cost": labor_cost,
        "burden_cost": f0(row.get("burden_cost")),
        "hours": f0(row.get("hours")),
        "regular_hours": f0(row.get("regular_hours")),
        "overtime_hours": f0(row.get("overtime_hours")),
        "scheduled_hours": f0(row.get("scheduled_hours")),
        "budget_revenue": f(row.get("budget_revenue")),
        "budget_labor": budget_labor,
        "labor_variance": round(labor_cost - budget_labor, 2) if budget_labor is not None else None,
        "hours_variance": round(f0(row.get("hours")) - f0(row.get("scheduled_hours")), 2),
        "employee_count": int(row.get("employee_count") or 0),
        "ar_open": f0(row.get("ar_open")),
        "days_outstanding_weighted": round(f0(row["days_outstanding_weighted"]), 1) if row.get("days_outstanding_weighted") is not None else None,
        "last_invoice_date": jsonable(row.get("last_invoice_date")),
        "last_work_date": jsonable(row.get("last_work_date")),
        "months_reporting": int(row.get("months_reporting") or 0),
        "status": status_from(alerts),
        "status_reasons": [a["detail"] for a in alerts],
        "company": row.get("company"),
        "delivery_model": row.get("delivery_model"),
        "geo_precision": row.get("geo_precision"),
        "subcontract_cost": f0(row.get("subcontract_cost")),
        "supplies_cost": f0(row.get("supplies_cost")),
        "other_direct_cost": f0(row.get("other_direct_cost")),
        "payroll_ti_cost": f0(row.get("payroll_ti_cost")),
        "direct_cost": f0(row.get("direct_cost")),
        "is_collectible_ar_only": bool(row.get("is_collectible_ar_only", True)),
    }


def fetch_job_rows(rng: MonthRange, filters: MartFilters) -> list[dict[str, Any]]:
    clause, params = filters.clause("jm")
    start, end = range_dates(rng)
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(JOB_ROWS_SQL.replace("{filters}", clause), (rng.start, rng.end, *params, start, end))
        return cursor.fetchall()


def totals(cursor: Any, rng: MonthRange, filters: MartFilters) -> dict[str, Any]:
    clause, params = filters.clause("jm")
    cursor.execute(TOTALS_SQL.replace("{filters}", clause), (rng.start, rng.end, *params))
    return cursor.fetchone() or {}


def ar_open_total(cursor: Any, filters: MartFilters) -> float:
    """Open AR for the scope: AR facts are invoice-grained, so the scope is applied by restricting
    to the job numbers `mart.job_month` selects (invoices with no service location drop out of a
    narrowed scope and stay in the unnarrowed one)."""
    clause, params = job_scope_subquery(filters, "o.job_number")
    cursor.execute(
        f"SELECT coalesce(sum(o.open_balance), 0) AS ar_open FROM mart.v_ar_open o WHERE true{clause}",
        params,
    )
    return f0(cursor.fetchone()["ar_open"])


def dso(cursor: Any, anchor: date, filters: MartFilters, ar_open: float) -> float | None:
    trailing = MonthRange("T3M", anchor, add_months(anchor, -2), anchor)
    revenue = f0(totals(cursor, trailing, filters).get("revenue"))
    return round(ar_open / (revenue / 91), 1) if revenue > 0 else None


# ── portfolio ────────────────────────────────────────────────────────────────
@router.get("/portfolio/summary")
def portfolio_summary(rng: MonthRange = Depends(resolve_request_range), filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    margin_target, _ = targets()
    clause, params = filters.clause("jm")
    with connection() as conn, conn.cursor() as cursor:
        now = totals(cursor, rng, filters)
        prior = totals(cursor, rng.prior(), filters)
        # Deltas are only honest when the prior range is fully covered by data: comparing the first
        # months of history against an empty prior window would print +1000% style growth.
        prior_rng = rng.prior()
        cursor.execute(
            "SELECT count(*) AS n FROM mart.portfolio_month WHERE month BETWEEN %s AND %s AND hours > 0",
            (prior_rng.start, prior_rng.end),
        )
        prior_covered = int((cursor.fetchone() or {}).get("n") or 0) >= prior_rng.months
        ar_open = ar_open_total(cursor, filters)
        dso_days = dso(cursor, rng.end, filters, ar_open)
        cursor.execute(
            f"""
            SELECT count(*) AS n FROM (
              SELECT jm.job_key FROM mart.job_month jm
              WHERE jm.month BETWEEN %s AND %s {clause}
              GROUP BY jm.job_key
              HAVING sum(jm.revenue) > 0 AND sum(jm.gross_profit) / sum(jm.revenue) < %s
            ) x
            """,
            (rng.start, rng.end, *params, margin_target),
        )
        below_target = cursor.fetchone()["n"]
        cursor.execute(
            "SELECT coalesce(sum(ap_invoiced), 0) AS ap_invoiced, coalesce(sum(ap_paid), 0) AS ap_paid FROM mart.portfolio_month WHERE month BETWEEN %s AND %s",
            (rng.start, rng.end),
        )
        ap = cursor.fetchone()
        trailing_start = add_months(rng.end, -11)
        cursor.execute(
            f"""
            WITH months AS (SELECT generate_series(%s::date, %s::date, interval '1 month')::date AS month),
            jm AS (
              SELECT jm.month, sum(jm.revenue) AS revenue, sum(jm.invoiced_total) AS invoiced_total,
                     sum(jm.collected_total) AS collected_total, sum(jm.budget_revenue) AS budget_revenue,
                     sum(jm.labor_cost) AS labor_cost, sum(jm.budget_labor) AS budget_labor, sum(jm.gross_profit) AS gross_profit,
                     sum(jm.hours) AS hours, sum(jm.overtime_hours) AS overtime_hours, sum(jm.scheduled_hours) AS scheduled_hours,
                     sum(jm.payroll_ti_cost) AS payroll_ti_cost, sum(jm.subcontract_cost) AS subcontract_cost,
                     sum(jm.supplies_cost) AS supplies_cost, sum(jm.other_direct_cost) AS other_direct_cost, sum(jm.direct_cost) AS direct_cost,
                     count(*) FILTER (WHERE jm.revenue <> 0 OR jm.hours <> 0) AS jobs_reporting
              FROM mart.job_month jm
              WHERE jm.month BETWEEN %s AND %s {clause}
              GROUP BY jm.month
            )
            SELECT m.month, coalesce(jm.revenue, 0) AS revenue, coalesce(jm.invoiced_total, 0) AS invoiced_total,
                   coalesce(jm.collected_total, 0) AS collected_total, jm.budget_revenue, coalesce(jm.labor_cost, 0) AS labor_cost,
                   jm.budget_labor, coalesce(jm.gross_profit, 0) AS gross_profit, coalesce(jm.hours, 0) AS hours,
                   coalesce(jm.overtime_hours, 0) AS overtime_hours, coalesce(jm.scheduled_hours, 0) AS scheduled_hours,
                   coalesce(jm.jobs_reporting, 0) AS jobs_reporting,
                   coalesce(pm.ap_invoiced, 0) AS ap_invoiced, coalesce(pm.ap_paid, 0) AS ap_paid,
                   coalesce(jm.payroll_ti_cost, 0) AS payroll_ti_cost, coalesce(jm.subcontract_cost, 0) AS subcontract_cost,
                   coalesce(jm.supplies_cost, 0) AS supplies_cost, coalesce(jm.other_direct_cost, 0) AS other_direct_cost,
                   coalesce(jm.direct_cost, 0) AS direct_cost
            FROM months m
            LEFT JOIN jm ON jm.month = m.month
            LEFT JOIN mart.portfolio_month pm ON pm.month = m.month
            ORDER BY m.month
            """,
            (trailing_start, rng.end, trailing_start, rng.end, *params),
        )
        monthly = [jsonable(row) for row in cursor.fetchall()]
        breakdowns = {name: breakdown(cursor, column, rng, filters) for name, column in (("by_region", "region"), ("by_service_type", "service_type"), ("by_account", "parent_account"), ("by_company", "company"))}
        # Coverage disclosure: what share of every account's revenue this scope carries. The
        # denominator is the whole portfolio for the same range - no scope, no other filter - so a
        # key-account view can state what it leaves out.
        all_revenue = f0(totals(cursor, rng, MartFilters(scope=SCOPE_ALL)).get("revenue"))

    revenue, prior_revenue = f0(now.get("revenue")), f0(prior.get("revenue"))
    hours, prior_hours = f0(now.get("hours")), f0(prior.get("hours"))
    margin, prior_margin = ratio(now.get("gross_profit"), revenue or None), ratio(prior.get("gross_profit"), prior_revenue or None)
    labor_pct, prior_labor_pct = ratio(now.get("labor_cost"), revenue or None), ratio(prior.get("labor_cost"), prior_revenue or None)
    ot_pct, prior_ot_pct = ratio(now.get("overtime_hours"), hours or None), ratio(prior.get("overtime_hours"), prior_hours or None)
    return {
        **envelope(rng, filters),
        "kpis": {
            "revenue": revenue,
            "revenue_prior": prior_revenue,
            "gross_profit": f0(now.get("gross_profit")),
            "gross_margin_pct": margin,
            "labor_cost": f0(now.get("labor_cost")),
            "labor_pct_revenue": labor_pct,
            "hours": hours,
            "overtime_hours": f0(now.get("overtime_hours")),
            "overtime_pct": ot_pct,
            "scheduled_hours": f0(now.get("scheduled_hours")),
            "hours_variance": round(hours - f0(now.get("scheduled_hours")), 2),
            "budget_revenue": f(now.get("budget_revenue")),
            "budget_labor": f(now.get("budget_labor")),
            "ar_open": round(ar_open, 2),
            "dso_days": dso_days,
            "active_jobs": int(now.get("active_jobs") or 0),
            "jobs_below_margin_target": int(below_target or 0),
            "ap_invoiced": f0(ap.get("ap_invoiced")),
            "ap_paid": f0(ap.get("ap_paid")),
            "payroll_ti_cost": f0(now.get("payroll_ti_cost")),
            "subcontract_cost": f0(now.get("subcontract_cost")),
            "supplies_cost": f0(now.get("supplies_cost")),
            "other_direct_cost": f0(now.get("other_direct_cost")),
            "direct_cost": f0(now.get("direct_cost")),
            "revenue_share_of_all": ratio(revenue, all_revenue or None),
            "revenue_all_accounts": round(all_revenue, 2),
        },
        "deltas": {
            "revenue_pct": pct_change(revenue, prior_revenue) if prior_covered else None,
            "gross_margin_pts": pts_delta(margin, prior_margin) if prior_covered else None,
            "labor_pct_pts": pts_delta(labor_pct, prior_labor_pct) if prior_covered else None,
            "overtime_pct_pts": pts_delta(ot_pct, prior_ot_pct) if prior_covered else None,
            "hours_pct": pct_change(hours, prior_hours) if prior_covered else None,
            "prior_range_covered": prior_covered,
            "prior_range": prior_rng.as_dict(),
        },
        "monthly": monthly,
        **breakdowns,
        "scope_note": (
            f"{filters.label}: {int(rng.months)} month(s) to {rng.end.isoformat()}. "
            f"ap_invoiced / ap_paid stay company-wide - WinTeam AP is not job-linked."
        ),
    }


def breakdown(cursor: Any, column: str, rng: MonthRange, filters: MartFilters) -> list[dict[str, Any]]:
    assert column in {"region", "service_type", "parent_account", "branch", "vertical", "company"}
    clause, params = filters.clause("jm")
    extra = ", array_remove(array_agg(DISTINCT jm.customer_number), NULL) AS customer_numbers" if column == "parent_account" else ""
    cursor.execute(
        f"""
        SELECT coalesce(jm.{column}, 'Unassigned') AS name, sum(jm.revenue) AS revenue, sum(jm.gross_profit) AS gross_profit,
               sum(jm.labor_cost) AS labor_cost, sum(jm.hours) AS hours, count(DISTINCT jm.job_key) AS jobs {extra}
        FROM mart.job_month jm
        WHERE jm.month BETWEEN %s AND %s {clause}
        GROUP BY 1
        ORDER BY revenue DESC, name
        """,
        (rng.start, rng.end, *params),
    )
    return [jsonable(row) for row in cursor.fetchall()]


# ── jobs ─────────────────────────────────────────────────────────────────────
@router.get("/jobs")
def jobs(rng: MonthRange = Depends(resolve_request_range), filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    margin_target, _ = targets()
    rows = fetch_job_rows(rng, filters)
    return {**envelope(rng, filters), "jobs": [job_row(row, margin_target) for row in rows]}


@router.get("/jobs/{job_number}")
def job_detail(job_number: str, months: int = Query(24, ge=1, le=60)) -> dict[str, Any]:
    margin_target, _ = targets()
    anchor = latest_mart_month() or month_start(date.today())
    rng = resolve_range("T12M", anchor)
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(f"WITH dims AS ({JOB_DIMS_SQL}) SELECT * FROM dims WHERE job_number = %s", (job_number,))
        dims = cursor.fetchone()
        if dims is None:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_number}")
        # A job page is its own scope: the key/other test must never hide the job being looked at.
        job_filters = MartFilters(job_number=job_number, scope=SCOPE_ALL)
        rows = fetch_job_rows(rng, job_filters)
        job = job_row(rows[0], margin_target) if rows else job_row({**dims, "employee_count": 0, "ar_open": 0, "months_reporting": 0}, margin_target)
        cursor.execute(
            "SELECT * FROM mart.job_month WHERE job_number = %s AND month > %s ORDER BY month",
            (job_number, add_months(anchor, -months)),
        )
        history = [jsonable(row) for row in cursor.fetchall()]
        schedule = schedule_vs_actual(cursor, job_number)
        cursor.execute("SELECT * FROM mart.v_ar_open WHERE job_number = %s ORDER BY invoice_date NULLS LAST", (job_number,))
        invoices = [jsonable(row) for row in cursor.fetchall()]
    return {
        "source": source_block(),
        "range": range_block(rng, job_filters),
        "job": job,
        "history": history,
        "schedule_vs_actual": schedule,
        "invoices": invoices,
        "forecast": job_forecast(job_number),
    }


def schedule_vs_actual(cursor: Any, job_number: str) -> list[dict[str, Any]]:
    cursor.execute(
        """
        SELECT greatest((SELECT max(work_date) FROM mart.v_timekeeping_effective WHERE job_number = %s),
                        (SELECT max(work_date) FROM core.fact_schedule WHERE job_number = %s)) AS last_day
        """,
        (job_number, job_number),
    )
    last_day = cursor.fetchone()["last_day"]
    if last_day is None:
        return []
    cursor.execute(
        """
        WITH weeks AS (
          SELECT (%s::date - extract(dow FROM %s::date)::int - n * 7)::date AS week_start FROM generate_series(0, 12) n
        ),
        sched AS (
          SELECT (work_date - extract(dow FROM work_date)::int)::date AS week_start, sum(coalesce(hours, 0)) AS scheduled_hours
          FROM core.fact_schedule WHERE job_number = %s GROUP BY 1
        ),
        actual AS (
          SELECT (work_date - extract(dow FROM work_date)::int)::date AS week_start,
                 sum(coalesce(hours, 0)) AS actual_hours, sum(coalesce(overtime_hours, 0)) AS overtime_hours
          FROM mart.v_timekeeping_effective WHERE job_number = %s GROUP BY 1
        )
        SELECT w.week_start, coalesce(s.scheduled_hours, 0) AS scheduled_hours,
               coalesce(a.actual_hours, 0) AS actual_hours, coalesce(a.overtime_hours, 0) AS overtime_hours
        FROM weeks w
        LEFT JOIN sched s ON s.week_start = w.week_start
        LEFT JOIN actual a ON a.week_start = w.week_start
        ORDER BY w.week_start
        """,
        (last_day, last_day, job_number, job_number),
    )
    return [jsonable(row) for row in cursor.fetchall()]


def job_forecast(job_number: str) -> dict[str, Any] | None:
    """Rows from the latest validated forecast run (migration 004 columns); None when absent."""
    try:
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute("SELECT forecast_run_id FROM mart.v_forecast_latest_run")
            run = cursor.fetchone()
            if run is None:
                return None
            run_id = run["forecast_run_id"]
            cursor.execute(
                """
                SELECT job_number, job_name, metric, basis_month, forecast_month, horizon_step,
                       point_forecast AS point, lower_bound AS lo, upper_bound AS hi, selected_model AS method,
                       explanation, n_history, status, volatility_class, input_periods AS input_months,
                       excluded_periods AS excluded_months, model_scores AS method_selection,
                       jsonb_build_object('source', interval_source) AS interval,
                       disruption, identity_meta AS identity, quality_meta AS quality, engine_version
                FROM mart.forecast_output
                WHERE forecast_run_id = %s AND job_number = %s
                ORDER BY metric, forecast_month
                """,
                (run_id, job_number),
            )
            rows = [jsonable(row) for row in cursor.fetchall()]
            cursor.execute(
                """
                SELECT metric, horizon_step, method, n_backtests, median_ape, mape, mase, coverage, volatility_class, engine_version
                FROM mart.forecast_accuracy
                WHERE forecast_run_id = %s AND job_number = %s
                ORDER BY metric, horizon_step
                """,
                (run_id, job_number),
            )
            accuracy = [jsonable(row) for row in cursor.fetchall()]
    except psycopg.Error as exc:
        logger.warning("Forecast lookup unavailable: %s", exc.__class__.__name__)
        return None
    if not rows and not accuracy:
        return None
    return {"run_id": str(run_id), "rows": rows, "accuracy": accuracy}


# ── accounts ─────────────────────────────────────────────────────────────────
@router.get("/accounts")
def accounts(rng: MonthRange = Depends(resolve_request_range), filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    margin_target, _ = targets()
    grouped: dict[str, dict[str, Any]] = {}
    for row in fetch_job_rows(rng, filters):
        name = row.get("parent_account") or "Unassigned"
        acc = grouped.setdefault(
            name,
            {"parent_account": name, "customer_numbers": set(), "jobs": 0, "revenue": 0.0, "gross_profit": 0.0, "labor_cost": 0.0,
             "budget_labor": None, "hours": 0.0, "overtime_hours": 0.0, "ar_open": 0.0, "_weighted": 0.0},
        )
        acc["jobs"] += 1
        if row.get("customer_number"):
            acc["customer_numbers"].add(row["customer_number"])
        for key in ("revenue", "gross_profit", "labor_cost", "hours", "overtime_hours", "ar_open"):
            acc[key] += f0(row.get(key))
        if row.get("budget_labor") is not None:
            acc["budget_labor"] = f0(acc["budget_labor"]) + f0(row["budget_labor"])
        if row.get("days_outstanding_weighted") is not None:
            acc["_weighted"] += f0(row["ar_open"]) * f0(row["days_outstanding_weighted"])
    result = []
    for acc in grouped.values():
        acc["days_outstanding_weighted"] = round(acc["_weighted"] / acc["ar_open"], 1) if acc["ar_open"] > 0 else None
        alerts = evaluate(acc, margin_target)
        result.append(
            {
                "parent_account": acc["parent_account"],
                "customer_numbers": sorted(acc["customer_numbers"]),
                "jobs": acc["jobs"],
                "revenue": round(acc["revenue"], 2),
                "gross_profit": round(acc["gross_profit"], 2),
                "gross_margin_pct": ratio(acc["gross_profit"], acc["revenue"] or None),
                "labor_cost": round(acc["labor_cost"], 2),
                "budget_labor": acc["budget_labor"],
                "hours": round(acc["hours"], 2),
                "overtime_hours": round(acc["overtime_hours"], 2),
                "ar_open": round(acc["ar_open"], 2),
                "days_outstanding_weighted": acc["days_outstanding_weighted"],
                "status": status_from(alerts),
                "status_reasons": [a["detail"] for a in alerts],
            }
        )
    result.sort(key=lambda a: (-a["revenue"], a["parent_account"]))
    return {**envelope(rng, filters), "accounts": result}


# ── receivables ──────────────────────────────────────────────────────────────
# WinTeam API source: buckets by days since invoice date as of today (mart.v_ar_open).
BUCKETS = (("current", "0-30"), ("d30", "31-60"), ("d60", "61-90"), ("d90", "91-120"), ("d90_plus", "120+"))
# Finance reference source: the WinTeam aging groups as of the latest AR aging snapshot.
SNAPSHOT_BUCKETS = (("current", "Current"), ("d30", "1-30"), ("d60", "31-60"), ("d90", "61-90"), ("d90_plus", "90+"))
SNAPSHOT_BUCKET_COLUMNS = {"current": "bucket_current", "d30": "bucket_1_30", "d60": "bucket_31_60", "d90": "bucket_61_90", "d90_plus": "bucket_90_plus"}


@router.get("/ar/aging")
def ar_aging(filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    """Open AR for the scope. There is no month range here (the aging is a snapshot), so the scope
    block sits at the top level instead of inside `range`."""
    source = source_block()
    if source.get("primary_source") == "finance_reference" and source.get("ar_as_of"):
        result = ar_aging_from_snapshot(filters, source)
    else:
        result = ar_aging_from_api(filters, source)
    result["cash_application"] = ar_cash_application(filters)
    result["scope"] = scope_block(filters)
    result["filters"] = filters.active()
    result["scope_note"] = (
        f"{filters.label}: only invoices whose service location is a job in scope. "
        "Invoices with no service location are excluded whenever the scope narrows the portfolio."
    )
    return result


def ar_cash_application(filters: MartFilters) -> dict[str, Any] | None:
    """How much of the open AR has had any cash applied, from the latest WinTeam aging snapshot.

    An invoice counts as having a payment applied when ``amount_due < invoice_amount``. The aging
    is only as accurate as cash application in WinTeam: an open balance with nothing applied may
    be genuinely unpaid or paid-but-unapplied, and the snapshot cannot tell the two apart. Returns
    None when no snapshot exists (WinTeam API source without a reference load).
    """
    clause, params = job_scope_subquery(filters, "s.job_number")
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT max(snapshot_date) AS d FROM core.fact_ar_aging_snapshot")
        snap = cursor.fetchone()
        as_of = snap["d"] if snap else None
        if as_of is None:
            return None
        cursor.execute(
            f"""
            WITH snap AS (
              SELECT s.invoice_date, s.invoice_amount, s.amount_due, s.bucket_90_plus,
                     coalesce(s.amount_due, 0) < coalesce(s.invoice_amount, 0) AS applied
              FROM core.fact_ar_aging_snapshot s
              WHERE s.snapshot_date = %s AND coalesce(s.amount_due, 0) <> 0{clause}
            )
            SELECT count(*) AS invoices_open,
                   count(*) FILTER (WHERE applied) AS invoices_applied,
                   coalesce(sum(amount_due) FILTER (WHERE NOT applied), 0) AS open_nothing_applied,
                   coalesce(sum(bucket_90_plus) FILTER (WHERE NOT applied), 0) AS open_nothing_applied_over_90,
                   min(invoice_date) AS oldest_open_invoice_date
            FROM snap
            """,
            (as_of, *params),
        )
        row = cursor.fetchone() or {}
    invoices_open = int(row.get("invoices_open") or 0)
    applied = int(row.get("invoices_applied") or 0)
    pct = round(applied / invoices_open * 100, 1) if invoices_open else None
    oldest = row.get("oldest_open_invoice_date")
    return {
        "as_of": as_of.isoformat(),
        "invoices_open": invoices_open,
        "invoices_with_payment_applied": applied,
        "pct_with_payment_applied": pct,
        "open_nothing_applied": round(f0(row.get("open_nothing_applied")), 2),
        "open_nothing_applied_over_90": round(f0(row.get("open_nothing_applied_over_90")), 2),
        "oldest_open_invoice_date": oldest.isoformat() if oldest else None,
        "note": (
            f"Open balances are WinTeam's AR aging as of {as_of.isoformat()}; they are only as accurate as "
            f"cash application in WinTeam. {pct if pct is not None else 0}% of open invoices have any payment applied."
        ),
    }


def ar_aging_from_api(filters: MartFilters, source: dict[str, Any]) -> dict[str, Any]:
    """Open AR by days since invoice date (WinTeam API source). The scope restricts the invoices to
    the job numbers `mart.job_month` selects; totals are therefore the scope's, not the company's."""
    clause, params = job_scope_subquery(filters, "o.job_number")
    anchor = latest_mart_month() or month_start(date.today())
    open_sql = f"""
        SELECT o.*, coalesce(i.is_collectible, true) AS is_collectible, i.company
        FROM mart.v_ar_open o
        LEFT JOIN core.fact_ar_invoice i ON i.ar_invoice_key = o.ar_invoice_key
        WHERE true{clause}
    """
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            WITH open_ar AS ({open_sql})
            SELECT aging_bucket, sum(open_balance) AS amount, count(*) AS invoices,
                   sum(open_balance) FILTER (WHERE is_collectible) AS collectible
            FROM open_ar GROUP BY 1
            """,
            params,
        )
        by_bucket = {row["aging_bucket"]: row for row in cursor.fetchall()}
        cursor.execute(
            f"""
            WITH open_ar AS ({open_sql})
            SELECT customer_number, customer_name, mode() WITHIN GROUP (ORDER BY parent_account) AS parent_account,
                   mode() WITHIN GROUP (ORDER BY company) AS company, bool_and(is_collectible) AS is_collectible,
                   sum(open_balance) FILTER (WHERE aging_bucket = 'current') AS bucket_current,
                   sum(open_balance) FILTER (WHERE aging_bucket = 'd30') AS bucket_d30,
                   sum(open_balance) FILTER (WHERE aging_bucket = 'd60') AS bucket_d60,
                   sum(open_balance) FILTER (WHERE aging_bucket = 'd90') AS bucket_d90,
                   sum(open_balance) FILTER (WHERE aging_bucket = 'd90_plus') AS bucket_d90_plus,
                   sum(open_balance) AS total, count(*) AS invoices
            FROM open_ar
            GROUP BY customer_number, customer_name
            ORDER BY total DESC, customer_number
            """,
            params,
        )
        by_customer = [_customer_row(row) for row in cursor.fetchall()]
        total_open = round(sum(f0(row["amount"]) for row in by_bucket.values()), 2)
        collectible_open = round(sum(f0(row["collectible"]) for row in by_bucket.values()), 2)
        dso_days = dso(cursor, anchor, filters, total_open)
        dso_collectible = dso(cursor, anchor, filters, collectible_open)
    return {
        "source": source,
        "as_of": date.today().isoformat(),
        "basis": "days since invoice date as of today (open = invoiceTotal - amountPaid)",
        "total_open": total_open,
        "collectible_open": collectible_open,
        "buckets": [
            {"bucket": key, "label": label, "amount": f0(by_bucket.get(key, {}).get("amount")), "invoices": int(by_bucket.get(key, {}).get("invoices") or 0)}
            for key, label in BUCKETS
        ],
        "by_customer": by_customer,
        "dso_days": dso_days,
        "dso_days_collectible": dso_collectible,
    }


def _customer_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "customer_number": row["customer_number"],
        "customer_name": row["customer_name"],
        "parent_account": row["parent_account"],
        "company": row.get("company"),
        "is_collectible": bool(row.get("is_collectible", True)),
        "current": f0(row["bucket_current"]),
        "d30": f0(row["bucket_d30"]),
        "d60": f0(row["bucket_d60"]),
        "d90": f0(row["bucket_d90"]),
        "d90_plus": f0(row["bucket_d90_plus"]),
        "total": f0(row["total"]),
        "invoices": int(row["invoices"]),
    }


def ar_aging_from_snapshot(filters: MartFilters, source: dict[str, Any]) -> dict[str, Any]:
    """Open AR as of the latest WinTeam aging snapshot (core.fact_ar_aging_snapshot), WinTeam groups as buckets.

    `collectible_open` excludes customers matched by the ar_treatment_rules setting (intercompany /
    settlement balances). Filters apply through the invoice's service-location job.
    """
    clause, params = job_scope_subquery(filters, "s.job_number")
    as_of = date.fromisoformat(source["ar_as_of"])
    anchor = latest_mart_month() or month_start(date.today())
    snap_sql = f"""
        WITH dims AS ({JOB_DIMS_SQL})
        SELECT s.*, d.parent_account
        FROM core.fact_ar_aging_snapshot s
        LEFT JOIN dims d ON d.job_number = s.job_number
        WHERE s.snapshot_date = %s AND coalesce(s.amount_due, 0) <> 0{clause}
    """
    bucket_sums = ", ".join(
        f"coalesce(sum({column}), 0) AS {key}, count(*) FILTER (WHERE coalesce({column}, 0) <> 0) AS {key}_invoices"
        for key, column in SNAPSHOT_BUCKET_COLUMNS.items()
    )
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            WITH snap AS ({snap_sql})
            SELECT coalesce(sum(amount_due), 0) AS total_open, coalesce(sum(amount_due) FILTER (WHERE is_collectible), 0) AS collectible_open,
                   count(*) AS invoices, {bucket_sums}
            FROM snap
            """,
            (as_of, *params),
        )
        totals_row = cursor.fetchone() or {}
        customer_buckets = ", ".join(f"coalesce(sum({column}), 0) AS bucket_{key}" for key, column in SNAPSHOT_BUCKET_COLUMNS.items())
        cursor.execute(
            f"""
            WITH snap AS ({snap_sql})
            SELECT customer_number, max(customer_name) AS customer_name, mode() WITHIN GROUP (ORDER BY parent_account) AS parent_account,
                   mode() WITHIN GROUP (ORDER BY company) AS company, bool_and(is_collectible) AS is_collectible,
                   {customer_buckets}, sum(amount_due) AS total, count(*) AS invoices
            FROM snap
            GROUP BY customer_number
            ORDER BY total DESC, customer_number
            """,
            (as_of, *params),
        )
        by_customer = [_customer_row(row) for row in cursor.fetchall()]
        total_open = round(f0(totals_row.get("total_open")), 2)
        collectible_open = round(f0(totals_row.get("collectible_open")), 2)
        dso_days = dso(cursor, anchor, filters, total_open)
        dso_collectible = dso(cursor, anchor, filters, collectible_open)
    return {
        "source": source,
        "as_of": as_of.isoformat(),
        "basis": "WinTeam AR aging snapshot groups (current = not yet due; others = days since invoice date) as of the snapshot date",
        "total_open": total_open,
        "collectible_open": collectible_open,
        "buckets": [
            {"bucket": key, "label": label, "amount": f0(totals_row.get(key)), "invoices": int(totals_row.get(f"{key}_invoices") or 0)}
            for key, label in SNAPSHOT_BUCKETS
        ],
        "by_customer": by_customer,
        "dso_days": dso_days,
        "dso_days_collectible": dso_collectible,
    }


@router.get("/ar/invoices")
def ar_invoices(
    bucket: str | None = Query(None),
    customer: str | None = Query(None),
    collectible: bool | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    filters: MartFilters = Depends(resolve_filters),
) -> dict[str, Any]:
    """Open AR invoices in the scope. `account=` still narrows to one account (it is part of the
    shared filter set now); the scope restricts to the job numbers `mart.job_month` selects."""
    if bucket and bucket not in {key for key, _ in BUCKETS} | {"unknown"}:
        raise HTTPException(status_code=422, detail="bucket must be one of current, d30, d60, d90, d90_plus")
    clause, params = job_scope_subquery(filters, "o.job_number")
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT o.*, coalesce(i.is_collectible, true) AS is_collectible, i.company, i.open_balance_basis,
                   i.days_outstanding_snapshot, i.aging_bucket_snapshot, i.parent_customer_name, count(*) OVER () AS total_count
            FROM mart.v_ar_open o
            LEFT JOIN core.fact_ar_invoice i ON i.ar_invoice_key = o.ar_invoice_key
            WHERE (%s::text IS NULL OR o.aging_bucket = %s)
              AND (%s::text IS NULL OR o.customer_number = %s)
              AND (%s::boolean IS NULL OR coalesce(i.is_collectible, true) = %s){clause}
            ORDER BY o.days_outstanding DESC NULLS LAST, o.open_balance DESC
            LIMIT %s OFFSET %s
            """,
            (bucket, bucket, customer, customer, collectible, collectible, *params, limit, offset),
        )
        rows = cursor.fetchall()
    total = int(rows[0]["total_count"]) if rows else 0
    items = [jsonable({k: v for k, v in row.items() if k != "total_count"}) for row in rows]
    return {"source": source_block(), "items": items, "total": total, "limit": limit, "offset": offset,
            "scope": scope_block(filters), "filters": filters.active()}


# ── payables ─────────────────────────────────────────────────────────────────
@router.get("/ap/summary")
def ap_summary(rng: MonthRange = Depends(resolve_request_range),
               filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    """AP invoiced / paid by invoice and payment month; open balances from the latest AP vendor aging snapshot.

    open_estimate (contract name) is the real open balance of that snapshot when one exists (finance
    reference source); it stays null for the WinTeam API source, whose payments are not invoice-linked.

    SCOPE: WinTeam AP is not job-linked, so no vendor figure here can be attributed to an account.
    The request's scope is echoed in `range.scope` and every figure stays COMPANY-WIDE; `scope_note`
    is the sentence to show next to the numbers.
    """
    start, end = range_dates(rng)
    source = source_block()
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT max(snapshot_date) AS d FROM core.fact_ap_aging_snapshot")
        snapshot_row = cursor.fetchone() or {}
        ap_as_of: date | None = snapshot_row.get("d")
        open_block: dict[str, Any] = {}
        if ap_as_of:
            cursor.execute(
                """
                SELECT coalesce(sum(balance), 0) AS open_balance,
                       coalesce(sum(balance) FILTER (WHERE coalesce(days_past_due, 0) > 0), 0) AS past_due,
                       count(*) FILTER (WHERE coalesce(balance, 0) <> 0) AS open_invoices,
                       count(DISTINCT vendor_number) FILTER (WHERE coalesce(balance, 0) <> 0) AS vendors_with_balance
                FROM core.fact_ap_aging_snapshot WHERE snapshot_date = %s
                """,
                (ap_as_of,),
            )
            open_block = jsonable(cursor.fetchone() or {})
        cursor.execute(
            """
            SELECT
              (SELECT coalesce(sum(invoice_amount), 0) FROM mart.v_ap_invoice_effective WHERE coalesce(invoice_date, posting_date) BETWEEN %s AND %s) AS invoiced,
              (SELECT count(*) FROM mart.v_ap_invoice_effective WHERE coalesce(invoice_date, posting_date) BETWEEN %s AND %s) AS invoices,
              (SELECT count(DISTINCT vendor_number) FROM mart.v_ap_invoice_effective WHERE coalesce(invoice_date, posting_date) BETWEEN %s AND %s) AS vendors,
              (SELECT coalesce(sum(amount), 0) FROM core.fact_ap_payment WHERE payment_date BETWEEN %s AND %s) AS paid
            """,
            (start, end) * 4,
        )
        kpis = jsonable(cursor.fetchone())
        cursor.execute(
            """
            WITH inv AS (
              SELECT vendor_number, sum(invoice_amount) AS invoiced, count(*) AS invoices
              FROM mart.v_ap_invoice_effective WHERE coalesce(invoice_date, posting_date) BETWEEN %s AND %s GROUP BY 1
            ),
            pay AS (
              SELECT vendor_number, sum(amount) AS paid, max(vendor_name) AS vendor_name
              FROM core.fact_ap_payment WHERE payment_date BETWEEN %s AND %s GROUP BY 1
            ),
            snap AS (
              SELECT vendor_number::integer AS vendor_number, sum(balance) AS open_balance,
                     sum(balance) FILTER (WHERE coalesce(days_past_due, 0) > 0) AS past_due, max(vendor_name) AS vendor_name
              FROM core.fact_ap_aging_snapshot
              WHERE snapshot_date = %s AND vendor_number ~ '^[0-9]+$' AND coalesce(balance, 0) <> 0
              GROUP BY 1
            ),
            keys AS (
              SELECT vendor_number FROM inv UNION SELECT vendor_number FROM pay UNION SELECT vendor_number FROM snap
            )
            SELECT k.vendor_number,
                   coalesce(v.vendor_name, pay.vendor_name, snap.vendor_name, 'Vendor ' || k.vendor_number::text) AS vendor_name,
                   coalesce(inv.invoiced, 0) AS invoiced, coalesce(pay.paid, 0) AS paid, coalesce(inv.invoices, 0) AS invoices,
                   coalesce(snap.open_balance, 0) AS open_balance, coalesce(snap.past_due, 0) AS past_due
            FROM keys k
            LEFT JOIN inv ON inv.vendor_number = k.vendor_number
            LEFT JOIN pay ON pay.vendor_number = k.vendor_number
            LEFT JOIN snap ON snap.vendor_number = k.vendor_number
            LEFT JOIN core.dim_vendor v ON v.vendor_number = k.vendor_number
            WHERE k.vendor_number IS NOT NULL
            ORDER BY invoiced DESC, open_balance DESC, paid DESC
            LIMIT 100
            """,
            (start, end, start, end, ap_as_of),
        )
        by_vendor = [jsonable(row) for row in cursor.fetchall()]
        cursor.execute(
            """
            WITH months AS (SELECT generate_series(%s::date, %s::date, interval '1 month')::date AS month),
            inv AS (SELECT month, sum(invoiced) AS invoiced FROM mart.v_ap_vendor_month GROUP BY 1),
            pay AS (SELECT month, sum(paid) AS paid FROM mart.v_ap_payment_month GROUP BY 1)
            SELECT m.month, coalesce(inv.invoiced, 0) AS invoiced, coalesce(pay.paid, 0) AS paid
            FROM months m LEFT JOIN inv ON inv.month = m.month LEFT JOIN pay ON pay.month = m.month
            ORDER BY m.month
            """,
            (rng.start, rng.end),
        )
        monthly = [jsonable(row) for row in cursor.fetchall()]
        cursor.execute("SELECT max(payment_date) AS d FROM core.fact_ap_payment")
        paid_through = (cursor.fetchone() or {}).get("d")
        due_base = ap_as_of if (ap_as_of and source.get("primary_source") == "finance_reference") else date.today()
        cursor.execute(
            """
            SELECT (due_date - extract(dow FROM due_date)::int)::date AS due_week_start,
                   sum(coalesce(open_balance, invoice_amount)) AS amount, count(*) AS invoices
            FROM mart.v_ap_invoice_effective
            WHERE due_date BETWEEN %s::date AND %s::date + 30 AND coalesce(open_balance, invoice_amount, 0) > 0
            GROUP BY 1 ORDER BY 1
            """,
            (due_base, due_base),
        )
        due = [jsonable(row) for row in cursor.fetchall()]
    # open_estimate: the real open balance from the latest vendor aging snapshot; null for the API source
    # (payments are not invoice-linked there).
    # Payment history can end before the invoice history (the reference source's vendor activity
    # export stops earlier than the aging snapshot); the browser labels the chart with this date.
    kpis["paid_through"] = paid_through.isoformat() if paid_through else None
    kpis["open_estimate"] = f(open_block.get("open_balance")) if ap_as_of else None
    kpis["open_balance"] = f(open_block.get("open_balance")) if ap_as_of else None
    kpis["past_due"] = f(open_block.get("past_due")) if ap_as_of else None
    kpis["open_invoices"] = int(open_block.get("open_invoices") or 0) if ap_as_of else None
    kpis["vendors_with_balance"] = int(open_block.get("vendors_with_balance") or 0) if ap_as_of else None
    return {"source": source, "range": range_block(rng, filters), "as_of": jsonable(ap_as_of),
            "due_from": due_base.isoformat(), "kpis": kpis, "by_vendor": by_vendor, "monthly": monthly,
            "due_next_30_days": due, "filters": filters.active(),
            "scope_note": (
                f"Scope requested: {filters.label}. Every AP figure on this page is COMPANY-WIDE: "
                "WinTeam AP invoices carry no job or account, so vendor spend cannot be attributed "
                "to a key account."
            )}


# ── timekeeping ──────────────────────────────────────────────────────────────
WEEKDAYS = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}


@router.get("/timekeeping/summary")
def timekeeping_summary(rng: MonthRange = Depends(resolve_request_range), filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    clause, params = filters.clause("jm")
    start, end = range_dates(rng)
    jobs_cte = f"jobs AS (SELECT DISTINCT jm.job_number, jm.job_name, jm.parent_account, jm.branch FROM mart.job_month jm WHERE true {clause})"
    with connection() as conn, conn.cursor() as cursor:
        now = totals(cursor, rng, filters)
        cursor.execute(
            f"""
            WITH {jobs_cte}
            SELECT count(DISTINCT t.employee_source_id) AS employees, count(*) AS punches
            FROM mart.v_timekeeping_effective t JOIN jobs j ON j.job_number = t.job_number
            WHERE t.work_date BETWEEN %s AND %s
            """,
            (*params, start, end),
        )
        counts = cursor.fetchone()
        daily_end = min(end, date.today())
        daily_start = daily_end - timedelta(days=55)
        cursor.execute(
            f"""
            WITH {jobs_cte},
            days AS (SELECT generate_series(%s::date, %s::date, interval '1 day')::date AS work_date),
            tk AS (
              SELECT t.work_date, sum(coalesce(t.hours, 0)) AS hours, sum(coalesce(t.overtime_hours, 0)) AS overtime_hours,
                     count(DISTINCT t.employee_source_id) AS employees
              FROM mart.v_timekeeping_effective t JOIN jobs j ON j.job_number = t.job_number
              WHERE t.work_date BETWEEN %s AND %s GROUP BY 1
            ),
            sc AS (
              SELECT s.work_date, sum(coalesce(s.hours, 0)) AS scheduled_hours
              FROM core.fact_schedule s JOIN jobs j ON j.job_number = s.job_number
              WHERE s.work_date BETWEEN %s AND %s GROUP BY 1
            )
            SELECT d.work_date, coalesce(tk.hours, 0) AS hours, coalesce(tk.overtime_hours, 0) AS overtime_hours,
                   coalesce(sc.scheduled_hours, 0) AS scheduled_hours, coalesce(tk.employees, 0) AS employees,
                   extract(isodow FROM d.work_date)::int AS isodow
            FROM days d LEFT JOIN tk ON tk.work_date = d.work_date LEFT JOIN sc ON sc.work_date = d.work_date
            ORDER BY d.work_date
            """,
            (*params, daily_start, daily_end, daily_start, daily_end, daily_start, daily_end),
        )
        daily_rows = cursor.fetchall()
        cursor.execute(
            f"""
            WITH {jobs_cte},
            emp AS (
              SELECT t.job_number, count(DISTINCT t.employee_source_id) AS employees
              FROM mart.v_timekeeping_effective t JOIN jobs j ON j.job_number = t.job_number
              WHERE t.work_date BETWEEN %s AND %s GROUP BY 1
            )
            SELECT jm.job_number, max(jm.job_name) AS job_name, max(jm.parent_account) AS parent_account,
                   sum(jm.scheduled_hours) AS scheduled_hours, sum(jm.hours) AS hours, sum(jm.overtime_hours) AS overtime_hours,
                   sum(jm.hours) - sum(jm.scheduled_hours) AS variance, coalesce(max(emp.employees), 0) AS employees
            FROM mart.job_month jm LEFT JOIN emp ON emp.job_number = jm.job_number
            WHERE jm.month BETWEEN %s AND %s {clause}
            GROUP BY jm.job_number
            ORDER BY hours DESC, jm.job_number
            """,
            (*params, start, end, rng.start, rng.end, *params),
        )
        by_job = [jsonable(row) for row in cursor.fetchall()]
        cursor.execute(
            f"""
            SELECT coalesce(jm.branch, 'Unassigned') AS branch, sum(jm.scheduled_hours) AS scheduled_hours,
                   sum(jm.hours) AS hours, sum(jm.overtime_hours) AS overtime_hours
            FROM mart.job_month jm WHERE jm.month BETWEEN %s AND %s {clause}
            GROUP BY 1 ORDER BY hours DESC
            """,
            (rng.start, rng.end, *params),
        )
        by_branch = [jsonable(row) for row in cursor.fetchall()]

    weekday_totals: dict[int, list[float]] = {}
    for row in daily_rows:
        weekday_totals.setdefault(row["isodow"], []).append(f0(row["hours"]))
    by_weekday = [
        {"isodow": dow, "label": WEEKDAYS[dow], "avg_hours": round(sum(values) / len(values), 2) if values else 0.0}
        for dow, values in sorted(weekday_totals.items())
    ]
    hours = f0(now.get("hours"))
    return {
        **envelope(rng, filters),
        "kpis": {
            "hours": hours,
            "regular_hours": f0(now.get("regular_hours")),
            "overtime_hours": f0(now.get("overtime_hours")),
            "overtime_pct": ratio(now.get("overtime_hours"), hours or None),
            "scheduled_hours": f0(now.get("scheduled_hours")),
            "hours_variance": round(hours - f0(now.get("scheduled_hours")), 2),
            "employees": int(counts["employees"] or 0),
            "punches": int(counts["punches"] or 0),
            "revenue_per_hour": ratio(now.get("revenue"), hours or None, 2),
        },
        "daily": [jsonable({k: v for k, v in row.items() if k != "isodow"}) for row in daily_rows],
        "by_weekday": by_weekday,
        "by_job": by_job,
        "by_branch": by_branch,
    }


# ── budget variance ──────────────────────────────────────────────────────────
@router.get("/budget/variance")
def budget_variance(rng: MonthRange = Depends(resolve_request_range), filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    clause, params = filters.clause("jm")
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT
              sum(jm.revenue) FILTER (WHERE jm.budget_revenue IS NOT NULL) AS revenue_actual,
              sum(jm.budget_revenue) AS revenue_budget,
              sum(jm.labor_cost) FILTER (WHERE jm.budget_labor IS NOT NULL) AS labor_actual,
              sum(jm.budget_labor) AS labor_budget,
              sum(jm.budget_subcontract) AS subcontract_budget,
              sum(jm.budget_supplies) AS supplies_budget,
              sum(jm.subcontract_cost) AS subcontract_actual,
              sum(jm.supplies_cost) AS supplies_actual,
              sum(jm.gross_profit) FILTER (WHERE jm.budget_revenue IS NOT NULL) AS gp_actual,
              sum(jm.budget_revenue - coalesce(jm.budget_direct_cost, coalesce(jm.budget_labor, 0) + coalesce(jm.budget_subcontract, 0) + coalesce(jm.budget_supplies, 0))) AS gp_budget,
              count(DISTINCT jm.job_key) AS jobs_total,
              count(DISTINCT jm.job_key) FILTER (WHERE jm.budget_revenue IS NOT NULL OR jm.budget_labor IS NOT NULL) AS jobs_with_budget
            FROM mart.job_month jm
            WHERE jm.month BETWEEN %s AND %s {clause}
            """,
            (rng.start, rng.end, *params),
        )
        t = cursor.fetchone()
        cursor.execute(
            f"""
            SELECT jm.month, sum(jm.revenue) AS revenue, sum(jm.budget_revenue) AS budget_revenue,
                   sum(jm.labor_cost) AS labor_cost, sum(jm.budget_labor) AS budget_labor
            FROM mart.job_month jm WHERE jm.month BETWEEN %s AND %s {clause}
            GROUP BY jm.month ORDER BY jm.month
            """,
            (rng.start, rng.end, *params),
        )
        monthly = [jsonable(row) for row in cursor.fetchall()]
        cursor.execute(
            f"""
            SELECT coalesce(jm.parent_account, 'Unassigned') AS parent_account, sum(jm.revenue) AS revenue,
                   sum(jm.budget_revenue) AS budget_revenue, sum(jm.labor_cost) AS labor_cost, sum(jm.budget_labor) AS budget_labor
            FROM mart.job_month jm WHERE jm.month BETWEEN %s AND %s {clause}
            GROUP BY 1 ORDER BY revenue DESC
            """,
            (rng.start, rng.end, *params),
        )
        by_account = [jsonable(row) for row in cursor.fetchall()]
        cursor.execute(
            f"""
            SELECT jm.job_number, max(jm.job_name) AS job_name, sum(jm.revenue) AS revenue, sum(jm.budget_revenue) AS budget_revenue,
                   sum(jm.labor_cost) AS labor_cost, sum(jm.budget_labor) AS budget_labor,
                   CASE WHEN sum(jm.budget_labor) > 0 THEN round((sum(jm.labor_cost) - sum(jm.budget_labor)) / sum(jm.budget_labor), 4) END AS labor_variance_pct
            FROM mart.job_month jm WHERE jm.month BETWEEN %s AND %s {clause}
            GROUP BY jm.job_number ORDER BY revenue DESC, jm.job_number
            """,
            (rng.start, rng.end, *params),
        )
        by_job = [jsonable(row) for row in cursor.fetchall()]

    def line(name: str, actual: Any, budget: Any, favorable_when_higher: bool) -> dict[str, Any]:
        actual_f, budget_f = f(actual), f(budget)
        variance = round(actual_f - budget_f, 2) if actual_f is not None and budget_f is not None else None
        favorable = None if variance is None else (variance >= 0 if favorable_when_higher else variance <= 0)
        return {"name": name, "actual": actual_f, "budget": budget_f, "variance": variance, "variance_pct": ratio(variance, budget_f), "favorable": favorable}

    source = source_block()
    if source.get("primary_source") == "finance_reference":
        # The job-cost P&L carries real subcontract and supplies actuals; budgets for them only exist via GL budgets.
        cost_lines = [
            line("Subcontract", t["subcontract_actual"], t["subcontract_budget"], False),
            line("Supplies", t["supplies_actual"], t["supplies_budget"], False),
        ]
    else:
        cost_lines = [
            line("Subcontract budget", None, t["subcontract_budget"], False),
            line("Supplies budget", None, t["supplies_budget"], False),
        ]
    lines = [
        line("Revenue", t["revenue_actual"], t["revenue_budget"], True),
        line("Labor", t["labor_actual"], t["labor_budget"], False),
        *cost_lines,
        line("Gross profit", t["gp_actual"], t["gp_budget"], True),
    ]
    return {
        "source": source,
        "range": range_block(rng, filters),
        "lines": lines,
        "monthly": monthly,
        "by_account": by_account,
        "by_job": by_job,
        "coverage": {"jobs_with_budget": int(t["jobs_with_budget"] or 0), "jobs_total": int(t["jobs_total"] or 0)},
    }


# ── alerts ───────────────────────────────────────────────────────────────────
@router.get("/alerts")
def alerts(rng: MonthRange = Depends(resolve_request_range), filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    margin_target, _ = targets()
    items: list[dict[str, Any]] = []
    for row in fetch_job_rows(rng, filters):
        for alert in evaluate(row, margin_target):
            items.append(
                {
                    "id": f"{alert['type']}:{row['job_number']}",
                    "severity": alert["severity"],
                    "type": alert["type"],
                    "job_number": row["job_number"],
                    "job_name": row.get("job_name"),
                    "parent_account": row.get("parent_account"),
                    "branch": row.get("branch"),
                    "detail": alert["detail"],
                    "metric_value": alert["metric_value"],
                    "threshold": alert["threshold"],
                }
            )
    items.sort(key=lambda a: (0 if a["severity"] == "critical" else 1, a["type"], a["job_number"]))
    return {**envelope(rng, filters), "alerts": items}
