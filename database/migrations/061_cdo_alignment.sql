-- 061: a punch with no rate of its own or its employee's is priced at what the job's rated punches paid
-- (normalize.price_punches), labor_cost_basis 'job_api_rate'. Site mappings the CDO's reports differ on,
-- for mappings the seed made (the seed never overwrites its own rows): USD1 leaves Amazon, and Crowley's
-- Montessori campus counts with Elementary.

ALTER TABLE core.fact_timekeeping DROP CONSTRAINT IF EXISTS fact_timekeeping_labor_cost_basis_check;
ALTER TABLE core.fact_timekeeping ADD CONSTRAINT fact_timekeeping_labor_cost_basis_check
  CHECK (labor_cost_basis IS NULL OR labor_cost_basis IN ('hours_x_rate', 'employee_rate', 'job_api_rate', 'export_dollars', 'trailing_job_rate', 'none'));

DELETE FROM ops.account_job WHERE company = 'Crane West' AND job_number = '509' AND account_slug = 'amazon' AND assigned_by = 'seed';
UPDATE ops.account_job SET segment = 'Elementary', updated_at = now()
WHERE company = 'Crane Southwest' AND job_number = '923' AND account_slug = 'crowley-isd' AND assigned_by = 'seed';
