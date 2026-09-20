"""Rebuild the reporting marts (mart.job_month, mart.portfolio_month) from the core facts.

Metric definitions (also recorded as column comments in migration 003 / 005)
---------------------------------------------------------------------------
A (job, month) row exists when ANY fact exists for it: AR invoices, timekeeping, schedules, GL
budgets, the job-cost P&L (core.fact_job_cost_month) or a labor budget. Two derivations coexist
and every row says which one it used (`revenue_basis`, `labor_basis`):

* In a month covered by a job-cost import (any core.fact_job_cost_month row for that month - the
  finance reference source) the finance-approved job-cost P&L is the ONLY revenue and cost basis,
  so mart.portfolio_month reconciles to the job-cost sums exactly: revenue, labor_cost = direct_labor, payroll_ti_cost,
  subcontract_cost, supplies_cost = materials + equipment_supplies, other_direct_cost,
  direct_cost = total_direct_costs, gross_profit = revenue - total_direct_costs, budget_revenue /
  budget_direct_cost / budget_hours, data_quality_status. `revenue_basis = labor_basis =
  'job_cost'`; burden_cost is 0 because payroll taxes and insurance are explicit. Hours,
  regular/overtime/double-time hours, employee_count, work_days and last_work_date come from
  the effective timekeeping rows when the month has punches, else actual_hours / overtime_hours from the
  job-cost row. A job invoiced or worked in such a month without a job-cost row keeps its AR
  invoiced_total and hours but carries 0 revenue / cost and the quality note `no_job_cost_row`.
* Otherwise (the WinTeam API source, or in-progress months of the reference source such as the
  month being worked): revenue / invoiced_total / collected_total / invoice_count come from
  the effective AR invoices grouped by job and service_month (billingPeriodFrom month, else invoiceDate
  month; `revenue_basis = 'ar_invoice'`). Invoices are NOT recognized revenue until Finance
  approves that definition; the UI labels them accordingly. labor_cost = sum(fact_timekeeping
  .labor_cost) (`labor_basis` = the timekeeping rows' labor_cost_basis: 'hours_x_rate' for the API,
  'trailing_job_rate' for the reference source). burden_cost = labor_cost x
  ops.app_setting.payroll_burden_rate; direct_cost = labor + burden; gross_profit = revenue -
  direct_cost (subcontract and supplies are not job-linked in the API).
* scheduled_hours come from core.fact_schedule by work_date month.
* budget_labor = core.fact_labor_budget_month (daily budget / hours budget comparison / wage by
  job), else the job-cost budget, else the GL budget class 'direct_labor'. budget_revenue = the
  job-cost budget when it is a real revenue budget (it differs from budget_direct_costs; in the
  reference dump the two columns are identical copies of the labor budget, so they are ignored),
  else the GL budget class 'revenue'. budget_subcontract / budget_supplies come from the GL budget
  classes (see normalize.py).
* gross_margin_pct is null when revenue = 0. Months after the current calendar month are
  excluded, and mart.portfolio_month only lists months with observed activity (revenue, hours,
  schedules, invoices or AP), so budget-only periods never move the "latest month" anchor.
* data_quality_status = 'warning' with quality_notes when revenue > 0 and hours = 0, hours > 0 and
  revenue = 0, the job is inactive, or the job-cost row itself carries a warning
  (`job_cost_warning`, kept as the reference marts report it).
* mart.portfolio_month adds AP invoiced/paid by invoice and payment month (AP is not job-linked)
  and the cost breakdown sums.

Source precedence (migration 011, docs/winteam-live-source.md "Precedence")
------------------------------------------------------------------------------
The live API (source 'winteam_api') and the export load ('finance_reference') share the fact tables.
Every read here goes through mart.v_timekeeping_effective / v_ar_invoice_effective /
v_ap_invoice_effective, which pick one source per grain: inside the API window
[min, max work_date of API punches] only API punches count for the companies the API tenant serves
(ops.app_setting.company_numbers labels; a gap day inside the window is trusted as "no punches"),
export punches count outside it and for other companies (Sarus); an API AR invoice supersedes the
export invoice with the same (customer_number, invoice_number); AP uses the invoice-date window.
API facts resolve their job through mart.v_api_job_map (migration 012): only dim_job rows of the
tenant's companies, the namespaced 'Crane:<number>' row for a job-number collision. The pure
functions api_window / effective_rows / effective_ar_rows / resolve_api_job below mirror the views.

After mart.portfolio_month the weekly executive mart mart.job_week is rebuilt in the same
transaction (app.weekly.rebuild; rules in docs/executive-pl.md). Then the forecast engine
(app.forecasting.build_forecasts) is invoked; if it is absent the result carries forecast = None.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import psycopg

from . import weekly
from .config import settings
from .db import connection

logger = logging.getLogger("marts")


class MartRebuildBlocked(RuntimeError):
    """The rebuild could not take its table locks before MART_REBUILD_LOCK_TIMEOUT_SECONDS elapsed."""


API_SOURCE = "winteam_api"
EFFECTIVE_VIEWS = {
    "timekeeping": "mart.v_timekeeping_effective",
    "ar_invoice": "mart.v_ar_invoice_effective",
    "ap_invoice": "mart.v_ap_invoice_effective",
}


# ── source precedence (pure mirror of the 011 views) ────────────────────────
def api_window(rows: list[dict[str, Any]], date_field: str) -> tuple[Any, Any]:
    """[min, max] of `date_field` over the API rows; (None, None) when the API has none."""
    dates = [r[date_field] for r in rows if r.get("source") == API_SOURCE and r.get(date_field) is not None]
    return (min(dates), max(dates)) if dates else (None, None)


def covered_by_api(company: str | None, api_companies: list[str] | tuple[str, ...]) -> bool:
    """True when a row of `company` is one the API tenant serves (no companies configured = all)."""
    return not api_companies or company is None or company in api_companies


def effective_rows(rows: list[dict[str, Any]], date_field: str, api_companies: list[str] | tuple[str, ...]) -> list[dict[str, Any]]:
    """Day-grain precedence: API rows always; non-API rows only outside the API window or for companies the API does not serve."""
    lo, hi = api_window(rows, date_field)
    out: list[dict[str, Any]] = []
    for r in rows:
        if r.get("source") == API_SOURCE:
            out.append(r)
            continue
        d = r.get(date_field)
        inside = lo is not None and d is not None and lo <= d <= hi
        if not (inside and covered_by_api(r.get("company"), api_companies)):
            out.append(r)
    return out


def api_namespace(api_companies: list[str] | tuple[str, ...]) -> str:
    """Namespace of the API tenant's job numbers: Sarus only when every configured company label is Sarus."""
    labels = [c for c in api_companies if c]
    return "Sarus" if labels and all("sarus" in c.lower() for c in labels) else "Crane"


def resolve_api_job(raw_job_number: str | None, dim_rows: list[dict[str, Any]], api_companies: list[str] | tuple[str, ...]) -> tuple[str | None, Any]:
    """Pure mirror of mart.v_api_job_map: (job_number, job_key) an API fact with `raw_job_number` resolves to.

    The bare-number current row when its company is one of the tenant's (or it has none / no
    companies configured); else the namespaced row '<namespace>:<number>' (job_key None when that
    row does not exist yet); a number with no dimension row at all resolves to itself.
    """
    current = [d for d in dim_rows if d.get("valid_to") is None and d.get("job_number") is not None]
    bare = next((d for d in current if d["job_number"] == raw_job_number), None)
    if bare is None:
        return raw_job_number, None
    if covered_by_api(bare.get("company"), api_companies):
        return bare["job_number"], bare.get("job_key")
    namespaced = f"{api_namespace(api_companies)}:{raw_job_number}"
    row = next((d for d in current if d["job_number"] == namespaced), None)
    return namespaced, (row.get("job_key") if row else None)


def effective_ar_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Invoice-grain precedence: an API invoice supersedes the export invoice with the same (customer_number, invoice_number)."""
    api_keys = {(r["customer_number"], r["invoice_number"]) for r in rows if r.get("source") == API_SOURCE}
    return [r for r in rows if r.get("source") == API_SOURCE or (r["customer_number"], r["invoice_number"]) not in api_keys]

JOB_MONTH_SQL = """
INSERT INTO mart.job_month (
  job_key, job_number, job_name, parent_account, customer_number, region, branch, service_type, vertical,
  manager_name, city, state_province, country_code, latitude, longitude, month,
  revenue, invoiced_total, collected_total, invoice_count,
  hours, regular_hours, overtime_hours, labor_cost, burden_cost, direct_cost, gross_profit, gross_margin_pct,
  scheduled_hours, budget_revenue, budget_labor, budget_subcontract, budget_supplies,
  employee_count, work_days, last_work_date, data_quality_status, quality_notes, rebuilt_at,
  source, company, delivery_model, geo_precision, payroll_ti_cost, subcontract_cost, supplies_cost, other_direct_cost,
  budget_direct_cost, budget_hours, revenue_basis, labor_basis, subcontract_basis, double_time_hours
)
WITH jobs AS (
  SELECT j.job_key, j.job_number, j.job_name, pa.account_name AS parent_account,
         j.region_name, j.branch_name, j.service_type, j.vertical, j.manager_name,
         j.city, j.state_province, j.country_code, j.latitude, j.longitude, j.is_active,
         j.source, j.company, j.delivery_model, j.geo_precision, j.customer_number AS dim_customer_number
  FROM core.dim_job j
  LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
  WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL
),
ar AS (
  SELECT jb.job_key, i.service_month AS month,
         sum(coalesce(i.revenue_total, 0)) AS revenue,
         sum(coalesce(i.invoice_total, 0)) AS invoiced_total,
         sum(coalesce(i.amount_paid, 0)) AS collected_total,
         count(*) AS invoice_count
  FROM mart.v_ar_invoice_effective i
  JOIN jobs jb ON jb.job_number = i.job_number
  WHERE i.service_month IS NOT NULL
  GROUP BY jb.job_key, i.service_month
),
tk AS (
  SELECT jb.job_key, date_trunc('month', t.work_date)::date AS month,
         sum(coalesce(t.hours, 0)) AS hours,
         sum(coalesce(t.regular_hours, 0)) AS regular_hours,
         sum(coalesce(t.overtime_hours, 0)) AS overtime_hours,
         sum(coalesce(t.double_time_hours, 0)) AS double_time_hours,
         sum(coalesce(t.labor_cost, 0)) AS labor_cost,
         count(DISTINCT t.employee_source_id) AS employee_count,
         count(DISTINCT t.work_date) AS work_days,
         max(t.work_date) AS last_work_date,
         mode() WITHIN GROUP (ORDER BY t.labor_cost_basis) AS labor_basis
  FROM mart.v_timekeeping_effective t
  JOIN jobs jb ON jb.job_number = t.job_number
  GROUP BY jb.job_key, date_trunc('month', t.work_date)
),
sc AS (
  SELECT jb.job_key, date_trunc('month', s.work_date)::date AS month, sum(coalesce(s.hours, 0)) AS scheduled_hours
  FROM core.fact_schedule s
  JOIN jobs jb ON jb.job_number = s.job_number
  GROUP BY jb.job_key, date_trunc('month', s.work_date)
),
bd AS (
  SELECT jb.job_key, m.budget_month AS month,
         sum(m.amount) FILTER (WHERE b.account_class = 'revenue') AS budget_revenue,
         sum(m.amount) FILTER (WHERE b.account_class = 'direct_labor') AS budget_labor,
         sum(m.amount) FILTER (WHERE b.account_class = 'subcontract') AS budget_subcontract,
         sum(m.amount) FILTER (WHERE b.account_class = 'supplies') AS budget_supplies
  FROM core.fact_gl_budget_month m
  JOIN core.fact_gl_budget b ON b.gl_budget_key = m.gl_budget_key
  JOIN jobs jb ON jb.job_number = b.job_number
  GROUP BY jb.job_key, m.budget_month
),
apd AS (
  -- Subcontract cost per job-month from AP GL distributions (migration 020). This is WinTeam's own
  -- coding of a payable to a site, so it needs no apportionment and no trailing-average projection:
  -- the accounts are whatever `gl_account_classes.subcontract` names (44000-44999 for this tenant).
  SELECT jb.job_key, v.month, sum(v.amount) AS subcontract
  FROM mart.v_ap_distribution_month v
  JOIN jobs jb ON jb.job_key = v.job_key
  WHERE v.gl_account_number ~ '^[0-9]+$'
    AND (v.gl_account_number)::bigint BETWEEN %(subcontract_gl_low)s AND %(subcontract_gl_high)s
  GROUP BY jb.job_key, v.month
),
jc AS (
  SELECT jb.job_key, c.month, c.source,
         c.revenue, c.direct_labor, c.payroll_taxes_insurance, c.materials, c.subcontractors, c.equipment_supplies,
         c.other_direct_costs, c.total_direct_costs, c.gross_profit, c.budget_revenue, c.budget_direct_costs, c.budget_labor,
         c.budget_hours, c.actual_hours, c.overtime_hours, c.data_quality_status
  FROM core.fact_job_cost_month c
  JOIN jobs jb ON jb.job_number = c.job_number
),
lb AS (
  SELECT jb.job_key, l.month, sum(l.budget_labor) AS budget_labor, sum(l.budget_hours) AS budget_hours
  FROM core.fact_labor_budget_month l
  JOIN jobs jb ON jb.job_number = l.job_number
  GROUP BY jb.job_key, l.month
),
jc_months AS (
  -- CLOSED months covered by a job-cost import: a job WITH a job-cost row in such a month takes its
  -- revenue and cost from the job-cost P&L, never from AR, so the finance-approved figure wins
  -- wherever it exists. A job the export SKIPPED falls back to its own AR and timekeeping and says
  -- so in revenue_basis / labor_basis; it is not reported as zero.
  --
  -- A job-cost row is only taken when it actually carries revenue. The export ships half-posted
  -- months as rows with revenue 0 and real labor (data_quality_status = 'warning'), and taking those
  -- literally suppressed $4.34M of invoiced July AR and $5.39M of August across 334 job-months -
  -- job 500's August read $0 against $517,334.27 that WinTeam had already invoiced. A row with no
  -- revenue is not a P&L; the job falls back to its own AR and says so. Where the month genuinely
  -- had no billing, AR is 0 too and `greatest` still yields 0, so a real zero is preserved.
  --
  -- This gate used to be month-level only: one job-cost row anywhere in a month forced every job in
  -- that month onto the job-cost basis, and a job absent from the export was published at 0 revenue
  -- against a full month of labor. That assumes the export is complete for a closed month. The
  -- 2026-09-03 export covers July partially and August barely, so July understated revenue by
  -- $3.66M (two fifths of it) and August by $7.86M (five sixths) - the business appeared to
  -- collapse. Per-row bases
  -- already exist for exactly this; mixed bases within a month are disclosed, not prevented.
  --
  -- A month is closed once month_end + close_lag_days is in the past; an in-progress month's
  -- job-cost import is partial (invoicing still running) and is labelled job_cost_partial.
  SELECT DISTINCT month FROM core.fact_job_cost_month
  WHERE (month + interval '1 month' - interval '1 day')::date
        + coalesce((SELECT (value #>> '{}')::int FROM ops.app_setting WHERE key = 'close_lag_days'), 5) < current_date
),
cust AS (
  SELECT jb.job_key, mode() WITHIN GROUP (ORDER BY i.customer_number) AS customer_number
  FROM mart.v_ar_invoice_effective i
  JOIN jobs jb ON jb.job_number = i.job_number
  GROUP BY jb.job_key
),
keys AS (
  SELECT job_key, month FROM ar
  UNION SELECT job_key, month FROM tk
  UNION SELECT job_key, month FROM sc
  UNION SELECT job_key, month FROM bd
  UNION SELECT job_key, month FROM jc
  UNION SELECT job_key, month FROM lb
  UNION SELECT job_key, month FROM apd
),
assembled AS (
  SELECT
    k.job_key, jb.job_number, jb.job_name, jb.parent_account, coalesce(cust.customer_number, jb.dim_customer_number) AS customer_number,
    jb.region_name, jb.branch_name, jb.service_type, jb.vertical, jb.manager_name,
    jb.city, jb.state_province, jb.country_code, jb.latitude, jb.longitude, k.month, jb.is_active,
    jb.company, jb.delivery_model, jb.geo_precision, coalesce(jc.source, jb.source) AS source,
    jm.month IS NOT NULL AND jc.job_key IS NOT NULL AND coalesce(jc.revenue, 0) <> 0 AS has_jc,
    jm.month IS NOT NULL AND (jc.job_key IS NULL OR coalesce(jc.revenue, 0) = 0) AS missing_jc_row,
    CASE WHEN jm.month IS NOT NULL AND jc.job_key IS NOT NULL AND coalesce(jc.revenue, 0) <> 0
           THEN jc.revenue
         ELSE greatest(coalesce(ar.revenue, 0), coalesce(jc.revenue, 0)) END AS revenue,
    coalesce(ar.invoiced_total, 0) AS invoiced_total,
    coalesce(ar.collected_total, 0) AS collected_total,
    coalesce(ar.invoice_count, 0) AS invoice_count,
    CASE WHEN tk.job_key IS NOT NULL THEN tk.hours
         WHEN jc.job_key IS NOT NULL THEN coalesce(jc.actual_hours, 0) ELSE 0 END AS hours,
    CASE WHEN tk.job_key IS NOT NULL THEN tk.regular_hours
         WHEN jc.job_key IS NOT NULL THEN greatest(coalesce(jc.actual_hours, 0) - coalesce(jc.overtime_hours, 0), 0) ELSE 0 END AS regular_hours,
    CASE WHEN tk.job_key IS NOT NULL THEN tk.overtime_hours
         WHEN jc.job_key IS NOT NULL THEN coalesce(jc.overtime_hours, 0) ELSE 0 END AS overtime_hours,
    coalesce(tk.double_time_hours, 0) AS double_time_hours,
    CASE WHEN jm.month IS NOT NULL AND jc.job_key IS NOT NULL THEN coalesce(jc.direct_labor, 0)
         WHEN tk.job_key IS NOT NULL THEN coalesce(tk.labor_cost, 0)
         ELSE coalesce(jc.direct_labor, 0) END AS labor_cost,
    CASE WHEN jm.month IS NOT NULL AND jc.job_key IS NOT NULL THEN 0
         ELSE round(coalesce(tk.labor_cost, 0) * %(burden)s::numeric, 2) END AS burden_cost,
    CASE WHEN jc.job_key IS NOT NULL THEN coalesce(jc.payroll_taxes_insurance, 0) ELSE 0 END AS payroll_ti_cost,
    -- The export's subcontract line wins only where the export row was the one actually used for
    -- this job-month (same gate as revenue); otherwise the AP distributions carry it. Before those
    -- distributions existed this fell to 0 and the weekly view projected a trailing average instead.
    CASE WHEN jm.month IS NOT NULL AND jc.job_key IS NOT NULL AND coalesce(jc.revenue, 0) <> 0
           THEN coalesce(jc.subcontractors, 0)
         ELSE coalesce(apd.subcontract, 0) END AS subcontract_cost,
    CASE WHEN jm.month IS NOT NULL AND jc.job_key IS NOT NULL AND coalesce(jc.revenue, 0) <> 0 THEN 'job_cost'
         WHEN apd.job_key IS NOT NULL THEN 'ap_distribution' END AS subcontract_basis,
    CASE WHEN jc.job_key IS NOT NULL THEN coalesce(jc.materials, 0) + coalesce(jc.equipment_supplies, 0) ELSE 0 END AS supplies_cost,
    CASE WHEN jc.job_key IS NOT NULL THEN coalesce(jc.other_direct_costs, 0) ELSE 0 END AS other_direct_cost,
    jc.total_direct_costs AS jc_direct_cost,
    jc.gross_profit AS jc_gross_profit,
    coalesce(sc.scheduled_hours, 0) AS scheduled_hours,
    -- The job-cost export's budget_revenue mirrors budget_direct_costs (the labor budget) on every
    -- budgeted row of the reference dump, so those two only count as revenue / direct-cost budgets
    -- when they differ; otherwise the GL revenue budget (API source) or nothing.
    coalesce(CASE WHEN jc.budget_revenue IS DISTINCT FROM jc.budget_direct_costs THEN jc.budget_revenue END, bd.budget_revenue) AS budget_revenue,
    coalesce(lb.budget_labor, jc.budget_labor, bd.budget_labor) AS budget_labor,
    bd.budget_subcontract, bd.budget_supplies,
    CASE WHEN jc.budget_revenue IS DISTINCT FROM jc.budget_direct_costs THEN jc.budget_direct_costs END AS budget_direct_cost,
    coalesce(lb.budget_hours, jc.budget_hours) AS budget_hours,
    coalesce(tk.employee_count, 0) AS employee_count,
    coalesce(tk.work_days, 0) AS work_days,
    tk.last_work_date,
    jc.data_quality_status AS jc_quality,
    CASE WHEN jm.month IS NOT NULL AND jc.job_key IS NOT NULL AND coalesce(jc.revenue, 0) <> 0 THEN 'job_cost'
         WHEN coalesce(jc.revenue, 0) > coalesce(ar.revenue, 0) THEN 'job_cost_partial'
         WHEN ar.job_key IS NOT NULL THEN 'ar_invoice' END AS revenue_basis,
    CASE WHEN jm.month IS NOT NULL AND jc.job_key IS NOT NULL THEN 'job_cost'
         WHEN tk.job_key IS NOT NULL THEN coalesce(tk.labor_basis, 'hours_x_rate')
         WHEN jc.job_key IS NOT NULL THEN 'job_cost_partial' END AS labor_basis
  FROM keys k
  JOIN jobs jb ON jb.job_key = k.job_key
  LEFT JOIN ar ON ar.job_key = k.job_key AND ar.month = k.month
  LEFT JOIN tk ON tk.job_key = k.job_key AND tk.month = k.month
  LEFT JOIN sc ON sc.job_key = k.job_key AND sc.month = k.month
  LEFT JOIN bd ON bd.job_key = k.job_key AND bd.month = k.month
  LEFT JOIN jc ON jc.job_key = k.job_key AND jc.month = k.month
  LEFT JOIN apd ON apd.job_key = k.job_key AND apd.month = k.month
  LEFT JOIN jc_months jm ON jm.month = k.month
  LEFT JOIN lb ON lb.job_key = k.job_key AND lb.month = k.month
  LEFT JOIN cust ON cust.job_key = k.job_key
  WHERE k.month <= date_trunc('month', current_date)::date
),
finished AS (
  SELECT a.*,
         CASE WHEN a.has_jc THEN coalesce(a.jc_direct_cost, 0)
              ELSE a.labor_cost + a.burden_cost + a.payroll_ti_cost + a.subcontract_cost + a.supplies_cost + a.other_direct_cost END AS direct_cost,
         CASE WHEN a.has_jc THEN coalesce(a.jc_gross_profit, 0)
              ELSE a.revenue - (a.labor_cost + a.burden_cost + a.payroll_ti_cost + a.subcontract_cost + a.supplies_cost + a.other_direct_cost) END AS gross_profit,
         array_remove(ARRAY[
           CASE WHEN a.revenue > 0 AND a.hours = 0 THEN 'revenue_without_hours' END,
           CASE WHEN a.hours > 0 AND a.revenue = 0 THEN 'hours_without_revenue' END,
           CASE WHEN NOT a.is_active THEN 'inactive_job' END,
           CASE WHEN a.jc_quality = 'warning' THEN 'job_cost_warning' END,
           CASE WHEN a.missing_jc_row AND (a.invoiced_total <> 0 OR a.hours <> 0) THEN 'no_job_cost_row' END
         ], NULL) AS notes
  FROM assembled a
)
SELECT
  job_key, job_number, job_name, parent_account, customer_number, region_name, branch_name, service_type, vertical,
  manager_name, city, state_province, country_code, latitude, longitude, month,
  revenue, invoiced_total, collected_total, invoice_count,
  hours, regular_hours, overtime_hours, labor_cost, burden_cost, direct_cost, gross_profit,
  CASE WHEN revenue <> 0 THEN round(gross_profit / revenue, 4) END,
  scheduled_hours, budget_revenue, budget_labor, budget_subcontract, budget_supplies,
  employee_count, work_days, last_work_date,
  CASE WHEN cardinality(notes) > 0 THEN 'warning' ELSE 'passed' END,
  to_jsonb(notes), now(),
  coalesce(source, 'winteam_api'), company, delivery_model, geo_precision, payroll_ti_cost, subcontract_cost, supplies_cost, other_direct_cost,
  budget_direct_cost, budget_hours, revenue_basis, labor_basis, subcontract_basis, double_time_hours
FROM finished
"""

PORTFOLIO_MONTH_SQL = """
INSERT INTO mart.portfolio_month (
  month, jobs_reporting, revenue, invoiced_total, collected_total, hours, regular_hours, overtime_hours,
  labor_cost, burden_cost, gross_profit, scheduled_hours, budget_revenue, budget_labor, ap_invoiced, ap_paid, rebuilt_at,
  payroll_ti_cost, subcontract_cost, supplies_cost, other_direct_cost, direct_cost, budget_direct_cost, double_time_hours
)
WITH jm AS (
  SELECT month,
         count(*) FILTER (WHERE revenue <> 0 OR hours <> 0) AS jobs_reporting,
         sum(revenue) AS revenue, sum(invoiced_total) AS invoiced_total, sum(collected_total) AS collected_total,
         sum(hours) AS hours, sum(regular_hours) AS regular_hours, sum(overtime_hours) AS overtime_hours,
         sum(labor_cost) AS labor_cost, sum(burden_cost) AS burden_cost, sum(gross_profit) AS gross_profit,
         sum(scheduled_hours) AS scheduled_hours, sum(budget_revenue) AS budget_revenue, sum(budget_labor) AS budget_labor,
         sum(payroll_ti_cost) AS payroll_ti_cost, sum(subcontract_cost) AS subcontract_cost, sum(supplies_cost) AS supplies_cost,
         sum(other_direct_cost) AS other_direct_cost, sum(direct_cost) AS direct_cost, sum(budget_direct_cost) AS budget_direct_cost,
         sum(double_time_hours) AS double_time_hours
  FROM mart.job_month
  GROUP BY month
),
api AS (
  SELECT date_trunc('month', coalesce(invoice_date, posting_date))::date AS month, sum(coalesce(invoice_amount, 0)) AS ap_invoiced
  FROM mart.v_ap_invoice_effective
  WHERE coalesce(invoice_date, posting_date) IS NOT NULL
  GROUP BY 1
),
app AS (
  SELECT date_trunc('month', payment_date)::date AS month, sum(coalesce(amount, 0)) AS ap_paid
  FROM core.fact_ap_payment
  WHERE payment_date IS NOT NULL
  GROUP BY 1
),
months AS (
  -- Budget-only months stay in mart.job_month but do not define the portfolio timeline, so the
  -- "latest month" anchor always points at a month with observed activity.
  -- The portfolio timeline starts at the first month with labor coverage: stray early invoices
  -- (late billings, credit memos landing from the API backfill) carry no labor and cannot support
  -- any P&L comparison, so they stay in mart.job_month but not on the portfolio timeline.
  SELECT month FROM jm
  WHERE (jobs_reporting > 0 OR scheduled_hours <> 0 OR invoiced_total <> 0)
    AND month >= (SELECT min(month) FROM jm WHERE hours > 0)
  UNION SELECT month FROM api WHERE month >= (SELECT min(month) FROM jm WHERE hours > 0)
  UNION SELECT month FROM app WHERE month >= (SELECT min(month) FROM jm WHERE hours > 0)
)
SELECT
  m.month, coalesce(jm.jobs_reporting, 0), coalesce(jm.revenue, 0), coalesce(jm.invoiced_total, 0),
  coalesce(jm.collected_total, 0), coalesce(jm.hours, 0), coalesce(jm.regular_hours, 0), coalesce(jm.overtime_hours, 0),
  coalesce(jm.labor_cost, 0), coalesce(jm.burden_cost, 0), coalesce(jm.gross_profit, 0), coalesce(jm.scheduled_hours, 0),
  jm.budget_revenue, jm.budget_labor, coalesce(api.ap_invoiced, 0), coalesce(app.ap_paid, 0), now(),
  coalesce(jm.payroll_ti_cost, 0), coalesce(jm.subcontract_cost, 0), coalesce(jm.supplies_cost, 0), coalesce(jm.other_direct_cost, 0),
  coalesce(jm.direct_cost, 0), jm.budget_direct_cost, coalesce(jm.double_time_hours, 0)
FROM months m
LEFT JOIN jm ON jm.month = m.month
LEFT JOIN api ON api.month = m.month
LEFT JOIN app ON app.month = m.month
WHERE m.month <= date_trunc('month', current_date)::date
"""


def _burden_rate(conn: Any) -> float:
    with conn.cursor() as cursor:
        cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'payroll_burden_rate'")
        row = cursor.fetchone()
    try:
        return max(0.0, float(row["value"])) if row else 0.0
    except (TypeError, ValueError):
        return 0.0


def _subcontract_gl_range(conn: Any) -> tuple[int, int]:
    """The GL account range `gl_account_classes.subcontract` names, as (low, high).

    Tenant-specific and editable from the Administration page, never hardcoded (44000-44999 here).
    Falls back to an empty range - which matches no account and therefore contributes no cost -
    rather than guessing, so a malformed setting understates instead of inventing.
    """
    with conn.cursor() as cursor:
        cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'gl_account_classes'")
        row = cursor.fetchone()
    try:
        ranges = ((row["value"] if row else {}) or {}).get("subcontract", {}).get("ranges") or []
        pairs = [(int(lo), int(hi)) for lo, hi in ranges if lo is not None and hi is not None]
        return (min(lo for lo, _ in pairs), max(hi for _, hi in pairs)) if pairs else (1, 0)
    except (AttributeError, TypeError, ValueError):
        logger.warning("gl_account_classes.subcontract is malformed; no AP distribution counts as subcontract")
        return (1, 0)


def _start_log(conn: Any) -> int:
    with conn.cursor() as cursor:
        cursor.execute("INSERT INTO mart.rebuild_log (status) VALUES ('running') RETURNING id")
        log_id = cursor.fetchone()["id"]
    conn.commit()
    return log_id


def _finish_log(log_id: int, status: str, job_rows: int | None, portfolio_rows: int | None, forecast_rows: int | None,
                error: str | None, job_week_rows: int | None = None) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            UPDATE mart.rebuild_log
            SET status = %s, completed_at = now(), job_month_rows = %s, portfolio_month_rows = %s,
                forecast_rows = %s, error_message = %s, job_week_rows = %s
            WHERE id = %s
            """,
            (status, job_rows, portfolio_rows, forecast_rows, error, job_week_rows, log_id),
        )
        conn.commit()


def rebuild_tables() -> tuple[int, int, int]:
    """TRUNCATE and rebuild the mart tables (job_month, portfolio_month, job_week) in one transaction; returns row counts.

    Runs under MART_REBUILD_LOCK_TIMEOUT_SECONDS (default 30) so that a session still holding locks
    on the tables this reads or truncates makes the rebuild fail with a diagnosable message instead
    of queueing behind it - a queued TRUNCATE blocks every reader of mart.* in turn.
    """
    with connection(lock_timeout_ms=settings.mart_rebuild_lock_timeout_seconds * 1000) as conn:
        rate = _burden_rate(conn)
        low, high = _subcontract_gl_range(conn)
        try:
            with conn.cursor() as cursor:
                cursor.execute("TRUNCATE mart.job_month")
                cursor.execute(JOB_MONTH_SQL, {"burden": rate,
                                               "subcontract_gl_low": low,
                                               "subcontract_gl_high": high})
                job_rows = cursor.rowcount
                cursor.execute("TRUNCATE mart.portfolio_month")
                cursor.execute(PORTFOLIO_MONTH_SQL)
                portfolio_rows = cursor.rowcount
                job_week_rows = weekly.rebuild(cursor)
        except psycopg.errors.LockNotAvailable as exc:
            raise MartRebuildBlocked(
                f"Mart rebuild could not take its locks within {settings.mart_rebuild_lock_timeout_seconds}s; "
                "another session is holding them. Check pg_stat_activity for a session that is "
                "'idle in transaction' (the ingestion worker is the usual suspect)."
            ) from exc
        conn.commit()
    return job_rows, portfolio_rows, job_week_rows


def build_forecasts(initiated_by: str) -> dict[str, Any] | None:
    """Call the separately maintained forecast engine; None when it is not installed."""
    try:
        from .forecasting import build_forecasts as engine  # type: ignore[import-not-found]
    except ImportError:
        logger.info("Forecast engine not available; skipping forecast build")
        return None
    try:
        return engine(initiated_by=initiated_by)
    except Exception as exc:  # noqa: BLE001 - forecasts must never break the mart rebuild
        logger.exception("Forecast build failed")
        return {"error": str(exc)[:500]}


def rebuild_all(initiated_by: str = "scheduled-rebuild") -> dict[str, Any]:
    """RebuildResult = {job_month_rows, portfolio_month_rows, job_week_rows, forecast, seconds}."""
    started = time.monotonic()
    with connection() as conn:
        log_id = _start_log(conn)
    try:
        job_rows, portfolio_rows, job_week_rows = rebuild_tables()
    except Exception as exc:
        _finish_log(log_id, "failed", None, None, None, str(exc)[:1000])
        raise
    forecast = build_forecasts(initiated_by)
    forecast_rows = forecast.get("forecast_rows") if isinstance(forecast, dict) else None
    _finish_log(log_id, "succeeded", job_rows, portfolio_rows, forecast_rows if isinstance(forecast_rows, int) else None, None, job_week_rows)
    seconds = round(time.monotonic() - started, 2)
    logger.info("Marts rebuilt by %s: job_month=%s portfolio_month=%s job_week=%s in %ss", initiated_by, job_rows, portfolio_rows, job_week_rows, seconds)
    return {"job_month_rows": job_rows, "portfolio_month_rows": portfolio_rows, "job_week_rows": job_week_rows, "forecast": forecast, "seconds": seconds}


def marts_empty_but_facts_exist() -> bool:
    """True when core holds facts but mart.job_month is empty (worker rebuilds on startup)."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT (SELECT count(*) FROM mart.job_month) AS mart_rows,
                   (SELECT EXISTS (SELECT 1 FROM core.fact_ar_invoice)
                        OR EXISTS (SELECT 1 FROM core.fact_timekeeping)
                        OR EXISTS (SELECT 1 FROM core.fact_schedule)
                        OR EXISTS (SELECT 1 FROM core.fact_gl_budget_month)
                        OR EXISTS (SELECT 1 FROM core.fact_job_cost_month)) AS facts
            """
        )
        row = cursor.fetchone()
    return bool(row) and row["mart_rows"] == 0 and bool(row["facts"])
