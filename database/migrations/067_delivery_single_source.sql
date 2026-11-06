-- 067: one delivery model for every page, resolved from evidence (app/delivery.py).
--
-- core.dim_job.delivery_model was written by the finance export (is_self_perform), the
-- delivery_model_by_vertical setting and the hours rule (066), and each page filled an empty label its own
-- way (hours that week, Relay flags, vendor-only). The export flag also overrode evidence: FedEx Klamath Falls
-- (523, 524) read self-performed while Relay pays ServiceMaster for both and Crane punches no hours there.
--
-- The declared value (export or vertical setting) moves to delivery_declared. delivery_model is now written only
-- by app/delivery.py at each mart rebuild, never empty, and delivery_basis says which rule decided it.
-- ops.job_delivery_override fixes a site by hand and beats every rule.
ALTER TABLE core.dim_job ADD COLUMN IF NOT EXISTS delivery_declared text;
ALTER TABLE core.dim_job ADD COLUMN IF NOT EXISTS delivery_basis text;
UPDATE core.dim_job SET delivery_declared = delivery_model WHERE delivery_declared IS NULL AND delivery_model IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.job_delivery_override (
  company        text NOT NULL,
  job_number     text NOT NULL,
  delivery_model text NOT NULL CHECK (delivery_model IN ('self_perform', 'subcontracted')),
  note           text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text,
  PRIMARY KEY (company, job_number)
);

UPDATE ops.app_setting
SET value = value || '{"subcontract_days": 92}'::jsonb,
    description = 'Delivery model evidence (app/delivery.py): a current job with at least min_hours punched in the last '
                  '`weeks` weeks is self-performed; otherwise subcontractor AP, Relay payables or job-cost subcontract '
                  'cost in the last subcontract_days days make it subcontracted unless its own labor dollars are larger. '
                  'Applied at each mart rebuild. weeks 0 skips the hours rule.'
WHERE key = 'delivery_from_hours' AND NOT value ? 'subcontract_days';
