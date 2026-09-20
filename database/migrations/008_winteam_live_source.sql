-- 008: The live WinTeam API as a second source coexisting with the finance_reference export load.
--
-- What changes (all additive; see docs/winteam-live-source.md):
-- * ops.app_setting.company_numbers maps the API's jobs/AP `companyNumber` onto the dashboard
--   company label ({"1": "Crane IFS", ...}). The jobs endpoint carries no company name, so this is
--   the only way to place an API job in the Crane / Sarus namespace used by the reference loader.
--   Seeded empty on purpose: fill it from the distinct companyNumber values a raw jobs sync lands.
-- * core.dim_customer.source may now say which loader discovered the customer number
--   ('winteam_api' for the receivables sync, 'finance_reference' for the export load); the legacy
--   values stay valid.
-- * Indexes on (source, date) so the mart precedence rules (API rows win the days / months they
--   cover, exports fill the rest) can be evaluated per source without scanning every fact.

INSERT INTO ops.app_setting (key, value, description) VALUES
  ('company_numbers', '{}'::jsonb,
   'WinTeam companyNumber (as a string key) -> dashboard company label, e.g. {"1": "Crane IFS", "2": "Crane West", "3": "Crane Southwest"}. Used by the live API source for jobs and AP invoices; an unmapped number keeps the company the reference load assigned.')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE core.dim_customer DROP CONSTRAINT IF EXISTS dim_customer_source_check;
ALTER TABLE core.dim_customer
  ADD CONSTRAINT dim_customer_source_check
  CHECK (source IN ('winteam', 'winteam_api', 'finance_reference', 'manual', 'config'));

CREATE INDEX IF NOT EXISTS fact_timekeeping_source_date_idx ON core.fact_timekeeping (source, work_date);
CREATE INDEX IF NOT EXISTS fact_ar_invoice_source_month_idx ON core.fact_ar_invoice (source, service_month);
CREATE INDEX IF NOT EXISTS fact_ap_invoice_source_date_idx ON core.fact_ap_invoice (source, invoice_date);
CREATE INDEX IF NOT EXISTS dim_job_source_idx ON core.dim_job (source) WHERE valid_to IS NULL;
