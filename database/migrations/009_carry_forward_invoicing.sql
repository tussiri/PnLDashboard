-- 009: Fifth weekly invoicing basis, carry_forward (docs/executive-pl.md).
--
-- Weeks in months that are not closed had no invoicing when neither contract billing nor AR for
-- the service month exists (basis 'none'), so the executive labor % was undefined for the current
-- weeks. Mirroring the original account_pl.py order, such a week now carries the job's most recent
-- closed month with job-cost revenue (within the last three closed months) forward, prorated by
-- calendar days exactly like job_cost_month_prorated, and the row is flagged invoicing_estimated.
-- 007 is left untouched; the basis CHECK is recreated here.
ALTER TABLE mart.job_week ADD COLUMN IF NOT EXISTS invoicing_estimated boolean NOT NULL DEFAULT false;
ALTER TABLE mart.job_week DROP CONSTRAINT IF EXISTS job_week_invoicing_basis_check;
ALTER TABLE mart.job_week
  ADD CONSTRAINT job_week_invoicing_basis_check
  CHECK (invoicing_basis IN ('job_cost_month_prorated', 'contract', 'ar_invoice_prorated', 'carry_forward', 'none'));
