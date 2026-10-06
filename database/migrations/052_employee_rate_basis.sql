-- 052: an API punch payroll has not rated yet is priced at the employee's latest WinTeam rate
-- (normalize.price_punches), labor_cost_basis 'employee_rate'.

ALTER TABLE core.fact_timekeeping DROP CONSTRAINT IF EXISTS fact_timekeeping_labor_cost_basis_check;
ALTER TABLE core.fact_timekeeping ADD CONSTRAINT fact_timekeeping_labor_cost_basis_check
  CHECK (labor_cost_basis IS NULL OR labor_cost_basis IN ('hours_x_rate', 'employee_rate', 'export_dollars', 'trailing_job_rate', 'none'));
