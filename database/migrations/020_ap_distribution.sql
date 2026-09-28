-- 020: AP GL distributions - the line that attributes a payable to a site.
--
-- The AP *list* endpoint returns invoice headers only (vendor, amount, dates), which is why this
-- platform recorded for months that "AP open balances cannot be derived" and that WinTeam AP "is not
-- job-linked", and why the Executive Overview projects subcontractor cost from a trailing average
-- instead of reporting it. That was a property of the endpoint being synced, not of the API:
-- GET /accounts/v1/api/payables/invoices/{invoiceNumber} carries
--
--     "generalLedgerDistributions": [{accountNumber, jobNumber, amount, ticketNumber, notes}]
--
-- verified against the production tenant. One row here is one such line, so subcontract, materials,
-- supplies and other direct costs become attributable to a job and a GL account from the API alone.
--
-- line_index is part of the key because an invoice may code the same job and account twice; it is
-- the position on the invoice, not a WinTeam identifier.
CREATE TABLE IF NOT EXISTS core.fact_ap_distribution (
  ap_distribution_key  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source               text NOT NULL DEFAULT 'winteam_api',
  company_number       text,
  vendor_number        text,
  invoice_number       text NOT NULL,
  line_index           integer NOT NULL,
  gl_account_number    text,
  job_number           text,
  job_key              bigint REFERENCES core.dim_job (job_key),
  amount               numeric(18,2),
  ticket_number        text,
  notes                text,
  invoice_date         date,
  posting_date         date,
  invoice_amount       numeric(18,2),
  warehouse_updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, invoice_number, line_index)
);

CREATE INDEX IF NOT EXISTS ap_distribution_job_idx ON core.fact_ap_distribution (job_number, invoice_date);
CREATE INDEX IF NOT EXISTS ap_distribution_job_key_idx ON core.fact_ap_distribution (job_key);
CREATE INDEX IF NOT EXISTS ap_distribution_account_idx ON core.fact_ap_distribution (gl_account_number);

-- Monthly cost per job and GL account, the shape the marts consume.
CREATE OR REPLACE VIEW mart.v_ap_distribution_month AS
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
