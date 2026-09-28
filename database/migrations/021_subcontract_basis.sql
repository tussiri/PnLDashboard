-- 021: subcontract_basis on mart.job_month.
--
-- Subcontract cost now has two possible sources and a row must say which it used, the same way
-- revenue_basis and labor_basis already do:
--
--   'job_cost'         the export's subcontractors line, taken only where that export row was the
--                      one actually used for this job-month (it carried revenue)
--   'ap_distribution'  summed from core.fact_ap_distribution over the GL accounts that
--                      gl_account_classes.subcontract names - WinTeam's own coding of a payable to
--                      a site, needing no apportionment and no trailing-average projection
--   NULL               neither source had anything for this job-month
--
-- Before migration 020 landed those distributions this fell to 0 wherever the export was silent,
-- which is why the Executive Overview projects vendor cost from a trailing three-month average.
ALTER TABLE mart.job_month ADD COLUMN IF NOT EXISTS subcontract_basis text;
CREATE INDEX IF NOT EXISTS job_month_subcontract_basis_idx ON mart.job_month (subcontract_basis, month);
