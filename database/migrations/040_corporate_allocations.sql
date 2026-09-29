-- 040: corporate allocations and the company-level income statement (app/allocations.py).
--
-- Three allocations, each from a WinTeam report and each overridable in Admin > Allocations:
--   management wages  Job Cost Analysis GL 40200-40399 (salaried management and supervision), kept
--                     per job and month; a subset of direct_labor, so existing labor % is unchanged.
--   payroll burden    payroll taxes and workers comp as a share of wages, from the company Trend
--                     Income Statement per month (or a manual rate), applied to the week's labor.
--   overhead          the company G&A lines of the Trend Income Statement per month (or a manual
--                     amount), spread over jobs by revenue, labor or hours.
-- Allocations never enter labor %; they reduce the margin shown after allocations.

ALTER TABLE core.fact_job_cost_month ADD COLUMN IF NOT EXISTS management_wages numeric(18, 2);

CREATE OR REPLACE VIEW mart.v_job_cost_month_effective AS
SELECT DISTINCT ON (job_number, month) source, job_number, month, job_name, company, revenue, direct_labor,
       payroll_taxes_insurance, materials, subcontractors, equipment_supplies, other_direct_costs, total_direct_costs,
       gross_profit, budget_revenue, budget_direct_costs, budget_labor, budget_hours, actual_hours, overtime_hours,
       data_quality_status, confidence_score, exception_count, lineage, warehouse_loaded_at, management_wages
FROM core.fact_job_cost_month
ORDER BY job_number, month, (source = 'export_import') DESC, warehouse_loaded_at DESC;

-- Company-wide Trend Income Statement lines (import kind income_statement with Account = Company).
CREATE TABLE IF NOT EXISTS core.fact_company_income_statement_month (
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  line text NOT NULL,
  amount numeric(18, 2) NOT NULL,
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  PRIMARY KEY (month, line)
);

-- Manual monthly figures that win over the income statement (a month not loaded yet, a correction).
CREATE TABLE IF NOT EXISTS ops.allocation_month (
  month date PRIMARY KEY CHECK (extract(day FROM month) = 1),
  burden_rate numeric(6, 4) CHECK (burden_rate IS NULL OR (burden_rate >= 0 AND burden_rate < 1)),
  overhead_pool numeric(18, 2) CHECK (overhead_pool IS NULL OR overhead_pool >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO ops.app_setting (key, value, description)
VALUES ('allocations',
        '{"management_wages": {"enabled": true},
          "burden": {"enabled": true, "lines": ["payroll_taxes", "workers_comp"]},
          "overhead": {"enabled": true, "lines": ["admin"], "basis": "revenue"}}',
        'Corporate allocations (app/allocations.py): which ones apply, the income statement lines behind burden and overhead, and how overhead is spread (revenue | labor | hours).')
ON CONFLICT (key) DO NOTHING;
