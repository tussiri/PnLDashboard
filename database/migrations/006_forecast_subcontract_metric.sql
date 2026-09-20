-- 006: Allow subcontract_cost as a forecast metric.
--
-- 005 added mart.job_month.subcontract_cost (job-cost P&L subcontractor line, finance_reference source).
-- The engine now forecasts it as its own series (gated on subcontract_cost > 0 in a closed month), so the
-- metric CHECK on mart.forecast_output must admit it. The constraint is recreated here; 004 is left untouched.
ALTER TABLE mart.forecast_output DROP CONSTRAINT IF EXISTS forecast_output_metric_check;
ALTER TABLE mart.forecast_output
  ADD CONSTRAINT forecast_output_metric_check
  CHECK (metric IN ('revenue', 'gross_profit', 'labor_cost', 'hours', 'subcontract_cost'));
