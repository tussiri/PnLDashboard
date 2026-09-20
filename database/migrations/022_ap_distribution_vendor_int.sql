-- 022: core.fact_ap_distribution.vendor_number becomes integer.
--
-- It was landed as text, which made it unjoinable to core.dim_vendor (integer) without a cast -
-- "operator does not exist: integer = text" - so no site could name the vendors working it. Every
-- other API-sourced fact (fact_ap_invoice, fact_ap_payment) already keys vendors as integer and only
-- the export-sourced aging snapshot uses text, so integer is the convention rather than a preference.
--
-- job_number and invoice_number stay text on purpose: both are genuinely alphanumeric in this tenant
-- (job "BalSheet", invoice "2026/US/Apr/001"). gl_account_number also stays text - the marts cast it
-- behind a numeric guard, and a chart of accounts is not guaranteed to be numeric.
-- mart.v_ap_distribution_month selects vendor_number, so the type change is blocked until the view
-- is dropped. Recreated verbatim below.
DROP VIEW IF EXISTS mart.v_ap_distribution_month;

ALTER TABLE core.fact_ap_distribution
  ALTER COLUMN vendor_number TYPE integer
  USING nullif(regexp_replace(vendor_number, '[^0-9-]', '', 'g'), '')::integer;

CREATE INDEX IF NOT EXISTS ap_distribution_vendor_idx ON core.fact_ap_distribution (vendor_number);

CREATE VIEW mart.v_ap_distribution_month AS
SELECT d.job_number,
       d.job_key,
       date_trunc('month', coalesce(d.posting_date, d.invoice_date))::date AS month,
       d.gl_account_number,
       sum(d.amount)                     AS amount,
       count(*)                          AS lines,
       count(DISTINCT d.invoice_number)  AS invoices,
       count(DISTINCT d.vendor_number)   AS vendors
FROM core.fact_ap_distribution d
WHERE d.job_number IS NOT NULL
  AND coalesce(d.posting_date, d.invoice_date) IS NOT NULL
GROUP BY 1, 2, 3, 4;
