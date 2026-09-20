-- 010: Record where a carried-forward weekly invoicing figure came from (docs/executive-pl.md).
--
-- 009's carry-forward used the job's latest closed month with job-cost revenue only, which carried
-- a partial job-cost month (e.g. a site whose July job-cost row holds a fraction of its AR billing)
-- and produced labor % far above 100%. The source is now the job's most recent month, within the
-- last three closed months, with job-cost OR AR service-month revenue, and the greater of the two is
-- carried; the row says which one won. 009 is left untouched.
ALTER TABLE mart.job_week
  ADD COLUMN IF NOT EXISTS carry_forward_source text
    CHECK (carry_forward_source IS NULL OR carry_forward_source IN ('job_cost', 'ar_invoice'));
