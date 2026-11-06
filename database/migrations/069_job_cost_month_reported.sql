-- Job cost with the AR revenue the export omits (migration 068, app/revenue_gap.py).
-- mart.v_job_cost_month_effective is the job-cost export as loaded; from July 2026 it lacks revenue GL 31808
-- and 34001, which mart.job_month adds back as revenue_ar_gap after each rebuild. Views that read job cost per
-- job (account monthly and income statement, Company P&L, the month rollup, budgets, weekly run rates) read
-- this view instead, so they agree with mart.job_month. The GL-as-posted views keep the effective view.
CREATE OR REPLACE VIEW mart.v_job_cost_month_reported AS
WITH gap AS (
  SELECT j.company, j.job_number, m.month, sum(m.revenue_ar_gap) AS revenue_ar_gap
  FROM mart.job_month m
  JOIN core.dim_job j ON j.job_key = m.job_key
  WHERE m.revenue_ar_gap <> 0
  GROUP BY 1, 2, 3
)
SELECT e.source, e.job_number, e.month, e.job_name, e.company,
       (e.revenue + coalesce(g.revenue_ar_gap, 0))::numeric(18,2) AS revenue,
       e.direct_labor, e.payroll_taxes_insurance, e.materials, e.subcontractors, e.equipment_supplies,
       e.other_direct_costs, e.total_direct_costs,
       (e.gross_profit + coalesce(g.revenue_ar_gap, 0))::numeric(18,2) AS gross_profit,
       e.budget_revenue, e.budget_direct_costs, e.budget_labor, e.budget_hours, e.actual_hours, e.overtime_hours,
       e.data_quality_status, e.confidence_score, e.exception_count, e.lineage, e.warehouse_loaded_at,
       e.management_wages,
       coalesce(g.revenue_ar_gap, 0)::numeric(18,2) AS revenue_ar_gap
FROM mart.v_job_cost_month_effective e
LEFT JOIN gap g ON g.company = e.company AND g.job_number = e.job_number AND g.month = e.month;

COMMENT ON VIEW mart.v_job_cost_month_reported IS
  'mart.v_job_cost_month_effective plus mart.job_month.revenue_ar_gap (revenue and gross_profit); revenue_ar_gap shows the amount added.';
