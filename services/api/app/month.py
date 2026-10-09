"""The month-end rollup: every job of a calendar month, shaped like a weekly leadership row.

At month end FedEx is invoiced and its subcontractors submit their invoices, so the month view reads
actuals and includes subcontracted sites (the weekly views leave them out for FedEx):

* labor, hours, OT and OT pay: each overlapping week of mart.leadership_week, split by the hours
  worked on the month's days (mart.v_timekeeping_daily), else by days, so the month uses the same
  labor as the weeks (pay report first, else the estimate);
* revenue: job cost for the month, else Relay AR by service month, else (a month not yet invoiced)
  the Relay contract amount, else the latest Relay AR or job cost month (an estimate), with its source.
  A subcontracted job takes Relay AR before job cost: its contract revenue is booked to a GL line with
  no job (from July 2026), so its job cost carries only the OS revenue line;
* vendor cost: Relay AP by service month (never for self-performed stations), else job cost
  subcontractors, else the weeks' projected vendor cost, with its source;
* sub_expected / sub_received: a subcontracted Relay station with a contract, and whether any of
  its payables for the month are in (FedEx: who has submitted);
* allocations at monthly amounts: management wages of the month, labor × the month's burden rate,
  the overhead pool × the job's share of the month's company revenue.

Rows carry invoice_week = the month's revenue, so the views read them with revenue method
weekly_billing (the invoice is the amount billed for the period).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from . import allocations

MONTH_SQL = """
WITH daily AS MATERIALIZED (
  SELECT t.job_key, t.work_date::date AS work_date, sum(t.hours) AS hours
  FROM mart.v_timekeeping_effective t
  WHERE t.work_date BETWEEN %(first)s::date - 6 AND %(last)s::date + 6
  GROUP BY 1, 2
),
wk AS MATERIALIZED (
  SELECT w.*, (least(w.week_start + 6, %(last)s::date) - greatest(w.week_start, %(first)s::date) + 1)::numeric / 7 AS day_share
  FROM mart.leadership_week w
  WHERE w.week_start + 6 >= %(first)s::date AND w.week_start <= %(last)s::date
),
wd AS (
  SELECT wk.job_key, wk.week_start,
         sum(d.hours) AS week_daily,
         sum(d.hours) FILTER (WHERE d.work_date BETWEEN %(first)s::date AND %(last)s::date) AS in_daily
  FROM wk JOIN daily d ON d.job_key = wk.job_key AND d.work_date BETWEEN wk.week_start AND wk.week_start + 6
  GROUP BY 1, 2
),
shares AS (
  SELECT wk.*, CASE WHEN coalesce(wd.week_daily, 0) > 0 THEN coalesce(wd.in_daily, 0) / wd.week_daily ELSE wk.day_share END AS share
  FROM wk LEFT JOIN wd USING (job_key, week_start)
),
m AS (
  SELECT job_key, max(company) AS company, max(job_number) AS job_number, max(site_name) AS site_name, max(parent_account) AS parent_account,
         sum(labor * share) AS labor, sum(hours * share) AS hours, sum(ot_hours * share) AS ot_hours, sum(ot_dollars * share) AS ot_dollars,
         sum(budget_hours * day_share) AS budget_hours, sum(budget_dollars * day_share) AS budget_dollars, sum(sub_week * day_share) AS sub_projected,
         bool_and(labor_basis = 'pay_report' OR labor = 0) AS pay_report, bool_and(labor_basis IN ('pay_report', 'payroll_rate') OR labor = 0) AS payroll_rate, max(employees) AS employees, sum(days_with_labor) AS days_with_labor,
         (array_agg(delivery_model ORDER BY week_start DESC) FILTER (WHERE delivery_model IS NOT NULL))[1] AS delivery_model,
         sum(revenue_month_budget_hours * day_share) AS rm_budget_hours
  FROM shares GROUP BY job_key
),
jcm AS MATERIALIZED (
  SELECT job_number, month, revenue, subcontractors, management_wages, direct_labor
  FROM mart.v_job_cost_month_effective WHERE month <= %(first)s::date
),
last_jc AS (SELECT DISTINCT ON (job_number) job_number, revenue FROM jcm WHERE month < %(first)s::date AND revenue > 0 ORDER BY job_number, month DESC),
rjm AS MATERIALIZED (SELECT * FROM mart.v_relay_job_month WHERE month <= %(first)s::date),
last_ar AS (SELECT DISTINCT ON (job_number) job_number, ar_revenue FROM rjm WHERE month < %(first)s::date AND ar_revenue > 0 ORDER BY job_number, month DESC)
SELECT m.*, j.latitude, j.longitude, j.city, j.state_province, j.parent_job_number,
       jc.revenue AS jc_revenue, jc.subcontractors AS jc_sub, jc.management_wages,
       r.ar_revenue, r.ar_invoices, r.ap_amount AS relay_ap, r.payables,
       pj.revenue AS prior_revenue, pj.direct_labor AS prior_labor, pj.subcontractors AS prior_sub,
       lj.revenue AS last_revenue, la.ar_revenue AS last_ar, c.ar_monthly AS contract_ar,
       c.ap_monthly > 0 AND NOT coalesce(c.self_perform, false) AS sub_expected
FROM m
LEFT JOIN core.dim_job j ON j.job_key = m.job_key
LEFT JOIN jcm jc ON jc.job_number = m.job_number AND jc.month = %(first)s::date
LEFT JOIN jcm pj ON pj.job_number = m.job_number AND pj.month = %(prior)s::date
LEFT JOIN rjm r ON r.job_number = m.job_number AND r.month = %(first)s::date
LEFT JOIN last_jc lj ON lj.job_number = m.job_number
LEFT JOIN last_ar la ON la.job_number = m.job_number
LEFT JOIN mart.v_relay_job_contract c ON c.job_number = m.job_number
"""

ACCOUNTS_SQL = """
SELECT aj.company, aj.job_number, aj.account_slug, aj.role, aj.needs_review,
       CASE WHEN aj.role = 'site' THEN coalesce(aj.segment, a.fallback_segment) END AS segment, a.revenue_allocation
FROM ops.account_job aj LEFT JOIN ops.account a ON a.slug = aj.account_slug
"""


def _f(v: Any) -> float:
    return float(v or 0)


def month_bounds(value: str) -> tuple[date, date, date]:
    first = date.fromisoformat(f"{value[:7]}-01")
    nxt = date(first.year + first.month // 12, first.month % 12 + 1, 1)
    prior = date(first.year - (first.month == 1), (first.month - 2) % 12 + 1, 1)
    return first, nxt - timedelta(days=1), prior


def month_row(r: dict[str, Any], mapping: dict[tuple[str, str], dict[str, Any]], first: date, last: date) -> dict[str, Any]:
    if r["delivery_model"] == "subcontracted" and _f(r["ar_revenue"]) > 0:
        revenue, revenue_source = _f(r["ar_revenue"]), "relay_ar"
    elif _f(r["jc_revenue"]) > 0:
        revenue, revenue_source = _f(r["jc_revenue"]), "job_cost"
    elif _f(r["ar_revenue"]) > 0:
        revenue, revenue_source = _f(r["ar_revenue"]), "relay_ar"
    elif _f(r["contract_ar"]) > 0:
        revenue, revenue_source = _f(r["contract_ar"]), "contract"
    elif _f(r["last_ar"]) > 0:
        revenue, revenue_source = _f(r["last_ar"]), "prior_month"
    elif _f(r["last_revenue"]) > 0:
        revenue, revenue_source = _f(r["last_revenue"]), "prior_month"
    else:
        revenue, revenue_source = 0.0, None
    self_perform = r["delivery_model"] == "self_perform"
    if r["relay_ap"] is not None and _f(r["relay_ap"]) > 0 and not self_perform:
        vendor, vendor_source = _f(r["relay_ap"]), "relay_ap"
    elif _f(r["jc_sub"]) > 0:
        vendor, vendor_source = _f(r["jc_sub"]), "job_cost"
    elif _f(r["sub_projected"]) > 0:
        vendor, vendor_source = _f(r["sub_projected"]), "projected"
    else:
        vendor, vendor_source = 0.0, None
    a = mapping.get((r["company"], r["job_number"]), {})
    return {
        "week_start": first.isoformat(), "week_end": last.isoformat(), "company": r["company"], "job_number": r["job_number"],
        "site_name": r["site_name"], "parent_account": r["parent_account"], "account_slug": a.get("account_slug"),
        "segment": a.get("segment"), "role": a.get("role") or "site", "needs_review": bool(a.get("needs_review")),
        "hours": round(_f(r["hours"]), 2), "ot_hours": round(_f(r["ot_hours"]), 2), "labor": round(_f(r["labor"]), 2),
        "labor_basis": "pay_report" if r["pay_report"] else "payroll_rate" if r["payroll_rate"] else "trailing_rate_estimate", "ot_dollars": round(_f(r["ot_dollars"]), 2),
        "budget_hours": round(_f(r["budget_hours"]), 2), "budget_dollars": round(_f(r["budget_dollars"]), 2),
        "employees": int(r["employees"] or 0), "days_with_labor": int(r["days_with_labor"] or 0),
        "revenue_month": first.isoformat(), "revenue_month_amount": round(revenue, 2), "revenue_month_basis": revenue_source,
        "revenue_allocated": 0, "allocation_weight": None, "invoice_week": round(revenue, 2),
        "prior_revenue": _f(r["prior_revenue"]), "prior_labor": _f(r["prior_labor"]), "prior_labor_basis": "job_cost" if r["prior_labor"] is not None else None,
        "prior_sub": _f(r["prior_sub"]), "prior_sub_basis": "job_cost" if r["prior_sub"] is not None else None,
        "delivery_model": r["delivery_model"], "sub_week": round(vendor, 2), "sub_week_basis": vendor_source,
        "consumables_cost": None, "consumables_basis": None, "latitude": r["latitude"], "longitude": r["longitude"],
        "city": r["city"], "state_province": r["state_province"], "parent_job_number": r["parent_job_number"], "dt_hours": 0,
        "sub_expected": bool(r["sub_expected"]), "sub_received": int(r["payables"] or 0) > 0, "ar_invoices": int(r["ar_invoices"] or 0),
        "_allocation": a.get("revenue_allocation"), "_rm_budget_hours": _f(r["rm_budget_hours"]), "_rm_hours": _f(r["hours"]),
        "_mgmt_month": _f(r["management_wages"]),
    }


def apply_allocations(cursor: Any, rows: list[dict[str, Any]], first: date, company_revenue: float) -> None:
    """Monthly allocations: management wages, labor × burden rate, the overhead pool × revenue share."""
    cfg = allocations.settings_of(cursor)
    fig = allocations.month_figures(first, cfg, allocations.statement(cursor), allocations.manual(cursor))
    for r in rows:
        r["alloc_management"] = round(r.pop("_mgmt_month", 0.0), 2) if cfg["management_wages"]["enabled"] else 0.0
        r["alloc_burden"] = round(r["labor"] * fig["burden_rate"], 2) if cfg["burden"]["enabled"] and fig["burden_rate"] else 0.0
        pool = fig["overhead_pool"] if cfg["overhead"]["enabled"] else None
        r["alloc_overhead"] = round(pool * r["revenue_month_amount"] / company_revenue, 2) if pool and company_revenue else 0.0


def rows_for(cursor: Any, month: str, allocate_parent_billing: Any) -> list[dict[str, Any]]:
    """Every job's month rollup (all accounts), with parent billing spread and allocations applied."""
    first, last, prior = month_bounds(month)
    cursor.execute(ACCOUNTS_SQL)
    mapping = {(r["company"], r["job_number"]): dict(r) for r in cursor.fetchall()}
    cursor.execute(MONTH_SQL, {"first": first, "last": last, "prior": prior})
    rows = allocate_parent_billing([month_row(dict(r), mapping, first, last) for r in cursor.fetchall()])
    for r in rows:
        r["invoice_week"] = r["revenue_month_amount"]
    apply_allocations(cursor, rows, first, sum(r["revenue_month_amount"] for r in rows))
    return rows
