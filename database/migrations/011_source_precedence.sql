-- 011: Precedence between the live WinTeam API rows and the finance_reference export rows
--      (docs/winteam-live-source.md "Precedence").
--
-- Both sources share core.fact_timekeeping / fact_ar_invoice / fact_ap_invoice (row-level `source`).
-- The marts and the reporting routes no longer read those tables directly; they read the
-- mart.v_*_effective views below, which pick ONE source per grain so nothing is counted twice:
--
-- * mart.v_timekeeping_effective - DAY grain. api_window = [min(work_date), max(work_date)] over the
--   API punches. Inside the window only API punches count for the companies the API tenant serves
--   (the labels of ops.app_setting.company_numbers; an export row with no company is treated as
--   covered). Export punches of companies the tenant does not serve (Sarus) keep counting on every
--   day, and every export punch outside the window counts. A day inside the window with no API
--   punches for a job is trusted as "no punches": the API is the system of record there, so an
--   export line for that day is NOT used to fill the gap. When company_numbers is empty the rule
--   degrades to the plain date window (every export row inside it is superseded).
-- * mart.v_ar_invoice_effective - INVOICE grain. An API invoice supersedes the export invoice with
--   the same (customer_number, invoice_number); everything else is the union of both sources.
-- * mart.v_ap_invoice_effective - INVOICE-DATE grain, same window rule as timekeeping over
--   coalesce(invoice_date, posting_date) and the same company scoping.
-- * mart.v_source_precedence exposes the window boundaries and the covered companies so the
--   coverage can be inspected (`SELECT * FROM mart.v_source_precedence`).
--
-- The legacy convenience views (v_timekeeping_daily, v_ar_open, v_ap_vendor_month) are recreated on
-- top of the effective views with their original column lists.
--
-- ops.app_setting.company_numbers was seeded empty by 008 on purpose; the tenant's numbers were
-- verified on 2026-09-03 (1 = Crane IFS, 2 = Crane West, 3 = Crane Southwest) and are filled here
-- only when the setting is still the empty object, so an operator's edit is never overwritten.

UPDATE ops.app_setting
SET value = '{"1": "Crane IFS", "2": "Crane West", "3": "Crane Southwest"}'::jsonb,
    updated_at = now(), updated_by = 'migration-011'
WHERE key = 'company_numbers' AND value = '{}'::jsonb;

CREATE INDEX IF NOT EXISTS fact_ar_invoice_customer_invoice_idx
  ON core.fact_ar_invoice (customer_number, invoice_number);

-- ---------------------------------------------------------------------------------------------
-- Coverage of the API source: window boundaries per fact and the companies the tenant serves
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.v_source_precedence AS
SELECT
  (SELECT min(work_date) FROM core.fact_timekeeping WHERE source = 'winteam_api') AS timekeeping_from,
  (SELECT max(work_date) FROM core.fact_timekeeping WHERE source = 'winteam_api') AS timekeeping_to,
  (SELECT min(coalesce(invoice_date, posting_date)) FROM core.fact_ap_invoice WHERE source = 'winteam_api') AS ap_invoice_from,
  (SELECT max(coalesce(invoice_date, posting_date)) FROM core.fact_ap_invoice WHERE source = 'winteam_api') AS ap_invoice_to,
  (SELECT count(*) FROM core.fact_ar_invoice WHERE source = 'winteam_api') AS ar_invoices_api,
  (SELECT coalesce(array_agg(DISTINCT e.value ORDER BY e.value), '{}'::text[])
     FROM ops.app_setting s
     CROSS JOIN LATERAL jsonb_each_text(s.value) e
     WHERE s.key = 'company_numbers' AND jsonb_typeof(s.value) = 'object' AND btrim(e.value) <> '') AS api_companies;

COMMENT ON VIEW mart.v_source_precedence IS
  'Coverage of the winteam_api source: [timekeeping_from, timekeeping_to] and [ap_invoice_from, ap_invoice_to] are the windows inside which only API rows count for the api_companies (labels of ops.app_setting.company_numbers).';

-- ---------------------------------------------------------------------------------------------
-- Effective facts (one source per grain)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.v_timekeeping_effective AS
SELECT t.*
FROM core.fact_timekeeping t
WHERE t.source = 'winteam_api'
UNION ALL
SELECT t.*
FROM core.fact_timekeeping t
CROSS JOIN mart.v_source_precedence p
WHERE t.source <> 'winteam_api'
  AND NOT (
    p.timekeeping_from IS NOT NULL
    AND t.work_date BETWEEN p.timekeeping_from AND p.timekeeping_to
    AND (cardinality(p.api_companies) = 0 OR t.company IS NULL OR t.company = ANY (p.api_companies))
  );

COMMENT ON VIEW mart.v_timekeeping_effective IS
  'core.fact_timekeeping with day-grain source precedence: inside the API window [min, max work_date of winteam_api rows] only API punches count for the companies the API serves (a gap day there is trusted as no punches); export punches count outside the window and for companies the API does not serve.';

CREATE OR REPLACE VIEW mart.v_ar_invoice_effective AS
SELECT i.*
FROM core.fact_ar_invoice i
WHERE i.source = 'winteam_api'
UNION ALL
SELECT i.*
FROM core.fact_ar_invoice i
WHERE i.source <> 'winteam_api'
  AND NOT EXISTS (
    SELECT 1 FROM core.fact_ar_invoice a
    WHERE a.source = 'winteam_api' AND a.customer_number = i.customer_number AND a.invoice_number = i.invoice_number
  );

COMMENT ON VIEW mart.v_ar_invoice_effective IS
  'core.fact_ar_invoice with invoice-grain source precedence: an API invoice supersedes the export invoice with the same (customer_number, invoice_number); otherwise the union of both sources.';

CREATE OR REPLACE VIEW mart.v_ap_invoice_effective AS
SELECT i.*
FROM core.fact_ap_invoice i
WHERE i.source = 'winteam_api'
UNION ALL
SELECT i.*
FROM core.fact_ap_invoice i
CROSS JOIN mart.v_source_precedence p
WHERE i.source <> 'winteam_api'
  AND NOT (
    p.ap_invoice_from IS NOT NULL
    AND coalesce(i.invoice_date, i.posting_date) BETWEEN p.ap_invoice_from AND p.ap_invoice_to
    AND (cardinality(p.api_companies) = 0 OR i.company IS NULL OR i.company = ANY (p.api_companies))
  );

COMMENT ON VIEW mart.v_ap_invoice_effective IS
  'core.fact_ap_invoice with invoice-date source precedence: inside the API window [min, max coalesce(invoice_date, posting_date) of winteam_api rows] only API invoices count for the companies the API serves; export invoices count outside it.';

-- ---------------------------------------------------------------------------------------------
-- Legacy convenience views, now on top of the effective facts (same column lists as 003)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.v_timekeeping_daily AS
SELECT job_number, job_key, work_date,
       sum(hours) AS hours,
       sum(regular_hours) AS regular_hours,
       sum(overtime_hours) AS overtime_hours,
       sum(labor_cost) AS labor_cost,
       count(DISTINCT employee_source_id) AS employees,
       count(*) AS punches
FROM mart.v_timekeeping_effective t
GROUP BY job_number, job_key, work_date;

CREATE OR REPLACE VIEW mart.v_ar_open AS
SELECT i.ar_invoice_key,
       i.customer_number,
       coalesce(c.customer_name, 'Customer ' || i.customer_number) AS customer_name,
       i.invoice_number,
       i.job_number,
       j.job_name,
       j.parent_account_key,
       pa.account_name AS parent_account,
       i.invoice_date,
       i.terms,
       i.invoice_total,
       i.amount_paid,
       i.open_balance,
       i.collection_status,
       current_date - i.invoice_date AS days_outstanding,
       CASE
         WHEN i.invoice_date IS NULL THEN 'unknown'
         WHEN current_date - i.invoice_date <= 30 THEN 'current'
         WHEN current_date - i.invoice_date <= 60 THEN 'd30'
         WHEN current_date - i.invoice_date <= 90 THEN 'd60'
         WHEN current_date - i.invoice_date <= 120 THEN 'd90'
         ELSE 'd90_plus'
       END AS aging_bucket
FROM mart.v_ar_invoice_effective i
LEFT JOIN core.dim_customer c ON c.customer_number = i.customer_number
LEFT JOIN core.dim_job j ON j.job_key = i.job_key
LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
WHERE coalesce(i.invoice_total, 0) - coalesce(i.amount_paid, 0) > 0.005;

CREATE OR REPLACE VIEW mart.v_ap_vendor_month AS
SELECT date_trunc('month', coalesce(i.invoice_date, i.posting_date))::date AS month,
       i.vendor_number,
       coalesce(v.vendor_name, 'Vendor ' || i.vendor_number::text) AS vendor_name,
       count(*) AS invoice_count,
       sum(i.invoice_amount) AS invoiced
FROM mart.v_ap_invoice_effective i
LEFT JOIN core.dim_vendor v ON v.vendor_number = i.vendor_number
GROUP BY 1, 2, 3;
