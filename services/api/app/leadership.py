"""mart.leadership_week: the weekly labor P&L behind the leadership views (migration 030).

Rebuilt after mart.job_week in every mart rebuild (marts.rebuild_tables). The account mapping is not
stored: routers/leadership.py joins ops.account_job at read time.

* Keys: every (job, Monday week) in mart.job_week or the imported pay report.
* Pay report coverage: a company's week counts as covered when core.pay_report_coverage spans each
  of its days that have passed (a nightly export window through yesterday covers the current week so
  far). Covered weeks take hours, overtime hours (OT + DT), labor and overtime dollars (full pay)
  from core.fact_pay_report; others take mart.job_week's hours and its trailing-rate labor, with
  overtime dollars estimated at 1.5x the straight-time rate labor / (hours + 0.5 x OT hours).
* revenue_month = the latest month with job-cost revenue (mart.job_month.revenue_basis = 'job_cost')
  before the month the week ends in. revenue_month_amount = the job's mart.job_month revenue for it.
* Keys also include every job with revenue in the week's revenue month, so a site billed but not
  worked that week still carries its invoice (the reference's "billed but no labor").
* prior_revenue = the same month's mart.job_month revenue; prior_labor = the month's pay report
  dollars when the pay report covers every day of it, else the job-cost labor
  (mart.job_month.labor_cost); prior_sub = the greater of the job-cost subcontract line and the AP
  distributions in the subcontract GL range for the job and month (prior_sub_basis says which).
* sub_week / sub_week_basis / delivery_model come from mart.job_week (vendor cost). A site with no
  job_week row (billed, no timekeeping) takes the revenue month's subcontract cost apportioned by
  days (basis 'prior_month_prorated'). Accounts with cost_basis 'labor_plus_vendor' measure cost %
  with it; others show it beside labor.
* revenue_month_budget_hours / revenue_month_hours: the job's budget and actual hours in the
  revenue month, the weights routers/leadership.py uses to spread a parent-billed account's
  revenue over its sites at read time (account setting revenue_allocation, migration 033).
* Relay (FedEx, migration 034) takes precedence for the jobs it covers: the week's vendor cost is
  Relay's payables for the week's service month (the month holding the week's Thursday) once that
  month is billed to the customer (Relay AR exists); while it is open, the greater of its payables so
  far and the average payables of the site's billed months among the three before it (basis
  trailing_3mo_projection; the contract covers only fixed work, so a pallet site's invoices run above
  it); with no billed month, the payables when at least 90% of the contract, else the contract (basis
  relay_ap / relay_contract; Crane's own sites carry none, relay_self_perform); prior_sub also considers Relay's payables; revenue comes
  from Relay's AR (supersession applied) when the job-cost export does not cover the month, and
  always for a subcontracted Relay site with AR that month, whose contract revenue is booked to a GL
  line with no job from July 2026, so its job cost carries only the OS revenue line
  (revenue_month_basis relay_ar); delivery_model falls back to Relay's self-perform flag.
* invoice_week = mart.job_week.invoicing (billing apportioned to the week), used only by accounts
  whose revenue_method is weekly_billing.
"""
from __future__ import annotations

from typing import Any

REBUILD_SQL = """
INSERT INTO mart.leadership_week (
  week_start, week_end, job_key, company, job_number, site_name, parent_account,
  hours, ot_hours, labor, labor_basis, ot_dollars, budget_hours, budget_dollars, employees, days_with_labor,
  revenue_month, revenue_month_amount, revenue_month_basis, invoice_week,
  prior_revenue, prior_labor, prior_labor_basis, prior_sub, prior_sub_basis, delivery_model, sub_week, sub_week_basis,
  revenue_month_budget_hours, revenue_month_hours, rebuilt_at)
WITH jobs AS (
  SELECT j.job_key, j.job_number, j.job_name, j.company, j.parent_job_number, pa.account_name AS parent_account
  FROM core.dim_job j
  LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
  WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL
),
cov_days AS (
  SELECT DISTINCT company, generate_series(date_from, date_to, interval '1 day')::date AS day
  FROM core.pay_report_coverage
),
pr AS (
  SELECT jb.job_key, date_trunc('week', p.work_date)::date AS week_start,
         sum(p.total_hours) AS hours,
         sum(p.overtime_hours + p.doubletime_hours) AS ot_hours,
         sum(p.total_dollars) AS labor,
         sum(p.overtime_dollars + p.doubletime_dollars) AS ot_dollars,
         count(DISTINCT p.employee_number) AS employees,
         count(DISTINCT p.work_date) AS days
  FROM core.fact_pay_report p
  JOIN jobs jb ON jb.job_number = p.job_number AND jb.company = p.company
  GROUP BY 1, 2
),
tk_emp AS (
  SELECT t.job_key, date_trunc('week', t.work_date)::date AS week_start, count(DISTINCT t.employee_source_id) AS employees
  FROM mart.v_timekeeping_effective t
  WHERE t.job_key IS NOT NULL
  GROUP BY 1, 2
),
jc_months AS (
  SELECT DISTINCT month FROM mart.job_month WHERE revenue_basis = 'job_cost'
),
all_weeks AS (
  SELECT week_start FROM mart.job_week UNION SELECT week_start FROM pr
),
week_month AS (
  SELECT w.week_start,
         (SELECT max(m.month) FROM jc_months m WHERE m.month < date_trunc('month', w.week_start + 6)::date) AS revenue_month
  FROM (SELECT DISTINCT week_start FROM all_weeks) w
),
keys AS (
  SELECT job_key, week_start FROM mart.job_week
  UNION SELECT job_key, week_start FROM pr
  UNION SELECT m.job_key, wm.week_start FROM week_month wm JOIN mart.job_month m ON m.month = wm.revenue_month AND m.revenue <> 0
),
relay_jm AS MATERIALIZED (
  SELECT job_number, month, ap_amount, ar_revenue FROM mart.v_relay_job_month
),
relay_trail AS (
  -- Per site and service month: the average payables of its billed months (AR exists) among the three before it.
  SELECT m.month, t.job_number, avg(t.ap_amount) AS ap
  FROM (SELECT DISTINCT date_trunc('month', week_start + 3)::date AS month FROM all_weeks) m
  JOIN relay_jm t ON t.month >= m.month - interval '3 months' AND t.month < m.month AND t.ap_amount > 0 AND t.ar_revenue IS NOT NULL
  GROUP BY 1, 2
),
ap_sub AS (
  SELECT v.job_key, v.month, sum(v.amount) AS amount
  FROM mart.v_ap_distribution_month v
  WHERE v.gl_account_number ~ '^[0-9]+$'
    AND (v.gl_account_number)::bigint BETWEEN %(subcontract_gl_low)s AND %(subcontract_gl_high)s
  GROUP BY 1, 2
),
week_cover AS (
  -- company-weeks whose passed days are all inside a pay report window
  SELECT k.week_start, jb.company
  FROM (SELECT DISTINCT week_start FROM keys) k
  CROSS JOIN (SELECT DISTINCT company FROM core.pay_report_coverage) jb
  WHERE (SELECT count(*) FROM cov_days c WHERE c.company = jb.company AND c.day BETWEEN k.week_start AND k.week_start + 6)
        >= least(7, current_date - k.week_start)
    AND k.week_start < current_date
),
month_cover AS (
  SELECT m.month, c.company
  FROM jc_months m
  JOIN cov_days c ON c.day BETWEEN m.month AND (m.month + interval '1 month' - interval '1 day')::date
  GROUP BY 1, 2
  HAVING count(*) = extract(day FROM (m.month + interval '1 month' - interval '1 day'))
),
pr_month AS (
  SELECT jb.job_key, date_trunc('month', p.work_date)::date AS month, sum(p.total_dollars) AS labor
  FROM core.fact_pay_report p
  JOIN jobs jb ON jb.job_number = p.job_number AND jb.company = p.company
  GROUP BY 1, 2
),
assembled AS (
  SELECT k.job_key, k.week_start, jb.company, jb.job_number,
         coalesce(jb.job_name, jw.site_name) AS site_name, jb.parent_account,
         wc.company IS NOT NULL AND pr.job_key IS NOT NULL AS covered,
         jw.hours AS jw_hours, coalesce(jw.ot_hours, 0) + coalesce(jw.dt_hours, 0) AS jw_ot, jw.direct_dollars AS jw_labor,
         pr.hours AS pr_hours, pr.ot_hours AS pr_ot, pr.labor AS pr_labor, pr.ot_dollars AS pr_ot_dollars,
         coalesce(pr.employees, te.employees, 0) AS employees,
         coalesce(pr.days, jw.days_with_labor, 0) AS days_with_labor,
         coalesce(jw.budget_hours, 0) AS budget_hours, coalesce(jw.budget_dollars, 0) AS budget_dollars,
         jw.invoicing AS invoice_week,
         wm.revenue_month,
         rm.revenue AS rm_revenue, rm.revenue_basis AS rm_basis, rm.labor_cost AS rm_labor, rm.subcontract_cost AS rm_sub,
         mc.company IS NOT NULL AS month_covered, prm.labor AS prm_labor, aps.amount AS ap_sub,
         jw.job_key IS NOT NULL AS has_jw, jw.delivery_model, coalesce(jw.sub_dollars, 0) AS sub_week, jw.sub_basis AS sub_week_basis,
         rm.budget_hours AS rm_budget_hours, rm.hours AS rm_hours,
         date_trunc('month', k.week_start + 3)::date AS week_month,
         rc.job_number IS NOT NULL OR coalesce(rw.ap_amount, 0) > 0 AS relay_covered,
         coalesce(rc.self_perform, false) AS relay_self_perform, rc.ap_monthly AS relay_ap_monthly,
         rw.ap_amount AS relay_week_ap, rw.ar_revenue AS relay_week_ar, rt.ap AS relay_trail_ap,
         rp.ap_amount AS relay_rm_ap, rp.ar_revenue AS relay_rm_ar
  FROM keys k
  JOIN jobs jb ON jb.job_key = k.job_key
  LEFT JOIN mart.job_week jw ON jw.job_key = k.job_key AND jw.week_start = k.week_start
  LEFT JOIN pr ON pr.job_key = k.job_key AND pr.week_start = k.week_start
  LEFT JOIN tk_emp te ON te.job_key = k.job_key AND te.week_start = k.week_start
  LEFT JOIN week_cover wc ON wc.week_start = k.week_start AND wc.company = jb.company
  LEFT JOIN week_month wm ON wm.week_start = k.week_start
  LEFT JOIN mart.job_month rm ON rm.job_key = k.job_key AND rm.month = wm.revenue_month
  LEFT JOIN month_cover mc ON mc.month = wm.revenue_month AND mc.company = jb.company
  LEFT JOIN pr_month prm ON prm.job_key = k.job_key AND prm.month = wm.revenue_month
  LEFT JOIN ap_sub aps ON aps.job_key = k.job_key AND aps.month = wm.revenue_month
  -- Relay (FedEx): keyed by WinTeam job number; Sarus reuses Crane job numbers, so never Sarus.
  LEFT JOIN mart.v_relay_job_contract rc ON rc.job_number = jb.job_number AND jb.company IS DISTINCT FROM 'Sarus'
  LEFT JOIN mart.v_relay_job_month rw ON rw.job_number = jb.job_number AND jb.company IS DISTINCT FROM 'Sarus'
         AND rw.month = date_trunc('month', k.week_start + 3)::date
  LEFT JOIN mart.v_relay_job_month rp ON rp.job_number = jb.job_number AND jb.company IS DISTINCT FROM 'Sarus'
         AND rp.month = wm.revenue_month
  LEFT JOIN relay_trail rt ON rt.job_number = jb.job_number AND jb.company IS DISTINCT FROM 'Sarus'
         AND rt.month = date_trunc('month', k.week_start + 3)::date
),
relay AS (
  -- Vendor cost for the week's service month from Relay: actual payables once the month is billed to
  -- the customer; while open, the greater of payables so far and the site's recent billed months
  -- (vendors bill in arrears, and a pallet site's invoices run above its fixed contract); with no history,
  -- actual payables when at least 90 percent of the contract, else the contract. Crane's own sites carry none.
  SELECT a.*,
         CASE WHEN NOT a.relay_covered THEN NULL
              WHEN a.relay_self_perform THEN 0
              WHEN a.relay_week_ar IS NOT NULL AND coalesce(a.relay_week_ap, 0) > 0 THEN a.relay_week_ap
              WHEN coalesce(a.relay_trail_ap, 0) > 0 THEN greatest(coalesce(a.relay_week_ap, 0), a.relay_trail_ap)
              WHEN coalesce(a.relay_week_ap, 0) > 0
                   AND (coalesce(a.relay_ap_monthly, 0) = 0 OR a.relay_week_ap >= 0.9 * a.relay_ap_monthly) THEN a.relay_week_ap
              WHEN coalesce(a.relay_ap_monthly, 0) > 0 THEN greatest(coalesce(a.relay_week_ap, 0), a.relay_ap_monthly)
         END AS relay_monthly,
         CASE WHEN NOT a.relay_covered THEN NULL
              WHEN a.relay_self_perform THEN 'relay_self_perform'
              WHEN a.relay_week_ar IS NOT NULL AND coalesce(a.relay_week_ap, 0) > 0 THEN 'relay_ap'
              WHEN coalesce(a.relay_trail_ap, 0) > 0
                THEN CASE WHEN coalesce(a.relay_week_ap, 0) >= a.relay_trail_ap THEN 'relay_ap' ELSE 'trailing_3mo_projection' END
              WHEN coalesce(a.relay_week_ap, 0) > 0
                   AND (coalesce(a.relay_ap_monthly, 0) = 0 OR a.relay_week_ap >= 0.9 * a.relay_ap_monthly) THEN 'relay_ap'
              WHEN coalesce(a.relay_ap_monthly, 0) > 0 THEN 'relay_contract'
         END AS relay_basis,
         (coalesce(a.rm_basis, '') <> 'job_cost' AND a.relay_rm_ar IS NOT NULL)
           OR (a.relay_covered AND NOT a.relay_self_perform AND coalesce(a.relay_rm_ar, 0) > 0
               AND coalesce(a.delivery_model, 'subcontracted') = 'subcontracted') AS relay_revenue
  FROM assembled a
)
SELECT
  a.week_start, a.week_start + 6, a.job_key, a.company, a.job_number, a.site_name, a.parent_account,
  CASE WHEN a.covered THEN a.pr_hours ELSE coalesce(a.jw_hours, 0) END,
  CASE WHEN a.covered THEN a.pr_ot ELSE a.jw_ot END,
  CASE WHEN a.covered THEN a.pr_labor ELSE coalesce(a.jw_labor, 0) END,
  CASE WHEN a.covered THEN 'pay_report' ELSE 'trailing_rate_estimate' END,
  CASE WHEN a.covered THEN a.pr_ot_dollars
       WHEN coalesce(a.jw_hours, 0) > 0
         THEN round(a.jw_ot * 1.5 * coalesce(a.jw_labor, 0) / (a.jw_hours + 0.5 * a.jw_ot), 2)
       ELSE 0 END,
  a.budget_hours, a.budget_dollars, a.employees, a.days_with_labor,
  a.revenue_month,
  CASE WHEN a.relay_revenue THEN a.relay_rm_ar ELSE coalesce(a.rm_revenue, 0) END,
  CASE WHEN a.relay_revenue THEN 'relay_ar' ELSE a.rm_basis END,
  a.invoice_week,
  CASE WHEN a.relay_revenue THEN a.relay_rm_ar ELSE coalesce(a.rm_revenue, 0) END,
  CASE WHEN a.month_covered THEN coalesce(a.prm_labor, 0) ELSE coalesce(a.rm_labor, 0) END,
  CASE WHEN a.month_covered THEN 'pay_report' WHEN a.rm_labor IS NOT NULL THEN 'job_cost' END,
  greatest(coalesce(a.rm_sub, 0), coalesce(a.ap_sub, 0), coalesce(a.relay_rm_ap, 0)),
  CASE WHEN coalesce(a.relay_rm_ap, 0) > greatest(coalesce(a.rm_sub, 0), coalesce(a.ap_sub, 0)) THEN 'relay_ap'
       WHEN coalesce(a.ap_sub, 0) > coalesce(a.rm_sub, 0) THEN 'ap_distribution' WHEN a.rm_sub IS NOT NULL THEN 'job_cost' END,
  coalesce(a.delivery_model, CASE WHEN a.relay_self_perform THEN 'self_perform' WHEN a.relay_covered THEN 'subcontracted' END),
  CASE WHEN a.relay_monthly IS NOT NULL
         THEN round(a.relay_monthly * 7 / extract(day FROM (a.week_month + interval '1 month' - interval '1 day')), 2)
       WHEN a.has_jw THEN a.sub_week
       WHEN a.revenue_month IS NOT NULL
         THEN round(greatest(coalesce(a.rm_sub, 0), coalesce(a.ap_sub, 0)) * 7
                    / extract(day FROM (a.revenue_month + interval '1 month' - interval '1 day')), 2)
       ELSE 0 END,
  CASE WHEN a.relay_monthly IS NOT NULL THEN a.relay_basis
       WHEN a.has_jw THEN a.sub_week_basis
       WHEN greatest(coalesce(a.rm_sub, 0), coalesce(a.ap_sub, 0)) > 0 THEN 'prior_month_prorated' END,
  coalesce(a.rm_budget_hours, 0), coalesce(a.rm_hours, 0),
  now()
FROM relay a
"""


def rebuild(cursor: Any, subcontract_gl: tuple[int, int]) -> int:
    """TRUNCATE and refill mart.leadership_week inside the caller's transaction; returns the row count."""
    cursor.execute("TRUNCATE mart.leadership_week")
    cursor.execute(REBUILD_SQL, {"subcontract_gl_low": subcontract_gl[0], "subcontract_gl_high": subcontract_gl[1]})
    return cursor.rowcount
