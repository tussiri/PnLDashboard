-- 054: Job cost rows of job numbers both WinTeam databases use (app/imports.py namespace_job_numbers).
--
-- core.fact_job_cost_month is keyed by (source, job_number, month), and the Job Cost Analysis import
-- stored every row under its bare WinTeam number. For the numbers both databases use (300 is FXE
-- Pittsburgh in Crane and Amazon BDL3/7 in Sarus, migration 012) the Crane and Sarus files wrote the
-- same row, so whichever company's file loaded last replaced the other's job for the month: Amazon
-- revenue and cost went missing when the Crane file followed the Sarus one.
--
-- The import now stores such a Crane row under its namespaced number ('Crane:300'), as API facts
-- already resolve (mart.v_api_job_map). This migration
--   1. re-keys the rows already held by the other database under a bare number, and
--   2. has the effective view pick a row per database as well (below).
-- A row a later file already overwrote can't be recovered here; reloading that month's file restores it.

UPDATE core.fact_job_cost_month f
SET job_number = k.namespace || ':' || f.job_number
FROM (
  SELECT x.source, x.job_number, x.month,
         CASE WHEN lower(x.company) LIKE '%sarus%' THEN 'Sarus' ELSE 'Crane' END AS namespace
  FROM core.fact_job_cost_month x
  JOIN core.dim_job d ON d.valid_to IS NULL AND d.job_number = x.job_number AND d.company IS NOT NULL
  WHERE x.company IS NOT NULL
    AND (lower(x.company) LIKE '%sarus%') <> (lower(d.company) LIKE '%sarus%')
) k
WHERE f.source = k.source AND f.job_number = k.job_number AND f.month = k.month
  AND NOT EXISTS (SELECT 1 FROM core.fact_job_cost_month y
                  WHERE y.source = f.source AND y.job_number = k.namespace || ':' || f.job_number AND y.month = f.month);

-- 2. The effective view picks one row per job number, month AND database. It picked one per job number
--    and month, so a Crane row for 300 hid the Sarus row for 300 even when both were held (Aug 2026:
--    FXE Pittsburgh hid Amazon BDL3/7, $319K of labor). Same columns, same order.
CREATE OR REPLACE VIEW mart.v_job_cost_month_effective AS
SELECT DISTINCT ON (job_number, month, (lower(coalesce(company, '')) LIKE '%sarus%'))
       source, job_number, month, job_name, company, revenue, direct_labor,
       payroll_taxes_insurance, materials, subcontractors, equipment_supplies, other_direct_costs, total_direct_costs,
       gross_profit, budget_revenue, budget_direct_costs, budget_labor, budget_hours, actual_hours, overtime_hours,
       data_quality_status, confidence_score, exception_count, lineage, warehouse_loaded_at, management_wages
FROM core.fact_job_cost_month
ORDER BY job_number, month, (lower(coalesce(company, '')) LIKE '%sarus%'), (source = 'export_import') DESC, warehouse_loaded_at DESC;
