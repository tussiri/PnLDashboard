-- 026: a second WinTeam database (Sarus) read live, kept apart from the primary (Crane).
--
-- Crane and Sarus are separate WinTeam databases whose job, vendor, employee and invoice numbers
-- overlap (job 300 is FXE Pittsburgh in Crane and Amazon BDL3/7 in Sarus). The Sarus connector
-- (app/tenants.py) lands its payloads as 'sarus/<resource>' in raw.winteam_record and writes core
-- rows with source 'winteam_sarus' and winteam_id 'api:sarus:<id>', so neither database can
-- overwrite the other's rows. Until now Sarus reached the warehouse only through the export load
-- (source 'finance_reference', company 'Sarus'), which stops on 2026-09-01.
--
-- Precedence becomes per database. Each API source has its own window, and supersedes only the
-- export rows of its own company:
--
-- * winteam_api   - unchanged: window = [min, max] of the winteam_api rows; supersedes export rows
--                   of the companies it serves (ops.app_setting.company_numbers labels).
-- * winteam_sarus - window = [min, max] of the winteam_sarus rows; supersedes export rows whose
--                   company is 'Sarus'. The Sarus backfill therefore never widens the Crane window.
-- * AR (invoice grain) - an API invoice supersedes the export invoice with the same
--                   (customer_number, invoice_number) OF ITS OWN DATABASE only: a Crane API invoice
--                   no longer hides a Sarus export invoice that happens to share the number.
--
-- mart.v_sarus_job_map is mart.v_api_job_map with the tenant fixed to Sarus: the bare-number row
-- when it is a Sarus job, else the namespaced 'Sarus:<n>' row. The effective views resolve each API
-- source's facts through its own map, so a reference reload that re-keys the dimension never
-- strands them.

ALTER TABLE core.dim_customer DROP CONSTRAINT IF EXISTS dim_customer_source_check;
ALTER TABLE core.dim_customer
  ADD CONSTRAINT dim_customer_source_check
  CHECK (source IN ('winteam', 'winteam_api', 'winteam_sarus', 'finance_reference', 'manual', 'config'));

CREATE OR REPLACE VIEW mart.v_sarus_job_map AS
SELECT d.job_number AS raw_job_number,
       c.covered AS bare_row_is_tenant,
       CASE WHEN c.covered THEN d.job_number ELSE 'Sarus:' || d.job_number END AS job_number,
       CASE WHEN c.covered THEN d.job_key ELSE ns.job_key END AS job_key,
       CASE WHEN c.covered THEN d.company ELSE ns.company END AS company,
       d.job_key AS bare_job_key,
       ns.job_key AS namespaced_job_key
FROM core.dim_job d
CROSS JOIN LATERAL (SELECT d.company IS NULL OR d.company = 'Sarus' AS covered) c
LEFT JOIN core.dim_job ns ON ns.valid_to IS NULL AND ns.job_number = 'Sarus:' || d.job_number
WHERE d.valid_to IS NULL AND d.job_number IS NOT NULL;

COMMENT ON VIEW mart.v_sarus_job_map IS
  'How a winteam_sarus fact''s jobNumber resolves to core.dim_job: the bare-number row when it is a Sarus job (or has no company), else the namespaced Sarus:<number> row (NULL job_key when it does not exist).';

-- Sarus coverage appended (CREATE OR REPLACE VIEW may only add columns at the end).
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
     WHERE s.key = 'company_numbers' AND jsonb_typeof(s.value) = 'object' AND btrim(e.value) <> '') AS api_companies,
  (SELECT CASE WHEN count(*) > 0 AND bool_and(lower(e.value) LIKE '%sarus%') THEN 'Sarus' ELSE 'Crane' END
     FROM ops.app_setting s
     CROSS JOIN LATERAL jsonb_each_text(s.value) e
     WHERE s.key = 'company_numbers' AND jsonb_typeof(s.value) = 'object' AND btrim(e.value) <> '') AS api_namespace,
  (SELECT min(work_date) FROM core.fact_timekeeping WHERE source = 'winteam_sarus') AS sarus_timekeeping_from,
  (SELECT max(work_date) FROM core.fact_timekeeping WHERE source = 'winteam_sarus') AS sarus_timekeeping_to,
  (SELECT min(coalesce(invoice_date, posting_date)) FROM core.fact_ap_invoice WHERE source = 'winteam_sarus') AS sarus_ap_invoice_from,
  (SELECT max(coalesce(invoice_date, posting_date)) FROM core.fact_ap_invoice WHERE source = 'winteam_sarus') AS sarus_ap_invoice_to,
  (SELECT count(*) FROM core.fact_ar_invoice WHERE source = 'winteam_sarus') AS sarus_ar_invoices_api;

COMMENT ON VIEW mart.v_source_precedence IS
  'Coverage of each live API source. winteam_api: [timekeeping_from, timekeeping_to] and [ap_invoice_from, ap_invoice_to], over the export rows of api_companies. winteam_sarus: the sarus_* windows, over the export rows of company Sarus.';

CREATE OR REPLACE VIEW mart.v_timekeeping_effective AS
SELECT t.timekeeping_key,
       t.winteam_id,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_key ELSE t.job_key END AS job_key,
       t.employee_source_id,
       t.work_date,
       t.regular_hours,
       t.overtime_hours,
       t.labor_cost,
       t.approval_status,
       t.source_updated_at,
       t.warehouse_loaded_at,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_number ELSE t.job_number END AS job_number,
       t.hours,
       t.category_detail_id,
       t.rate,
       t.in_time,
       t.out_time,
       t.lunch,
       t.work_ticket_number,
       t.pay_week_start,
       t.overtime_basis,
       t.source,
       t.company,
       t.double_time_hours,
       t.hours_type,
       t.employee_name,
       t.labor_cost_basis
FROM core.fact_timekeeping t
LEFT JOIN mart.v_api_job_map m ON m.raw_job_number = t.job_number
WHERE t.source = 'winteam_api'
UNION ALL
SELECT t.timekeeping_key,
       t.winteam_id,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_key ELSE t.job_key END AS job_key,
       t.employee_source_id,
       t.work_date,
       t.regular_hours,
       t.overtime_hours,
       t.labor_cost,
       t.approval_status,
       t.source_updated_at,
       t.warehouse_loaded_at,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_number ELSE t.job_number END AS job_number,
       t.hours,
       t.category_detail_id,
       t.rate,
       t.in_time,
       t.out_time,
       t.lunch,
       t.work_ticket_number,
       t.pay_week_start,
       t.overtime_basis,
       t.source,
       t.company,
       t.double_time_hours,
       t.hours_type,
       t.employee_name,
       t.labor_cost_basis
FROM core.fact_timekeeping t
LEFT JOIN mart.v_sarus_job_map m ON m.raw_job_number = t.job_number
WHERE t.source = 'winteam_sarus'
UNION ALL
SELECT t.timekeeping_key,
       t.winteam_id,
       t.job_key,
       t.employee_source_id,
       t.work_date,
       t.regular_hours,
       t.overtime_hours,
       t.labor_cost,
       t.approval_status,
       t.source_updated_at,
       t.warehouse_loaded_at,
       t.job_number,
       t.hours,
       t.category_detail_id,
       t.rate,
       t.in_time,
       t.out_time,
       t.lunch,
       t.work_ticket_number,
       t.pay_week_start,
       t.overtime_basis,
       t.source,
       t.company,
       t.double_time_hours,
       t.hours_type,
       t.employee_name,
       t.labor_cost_basis
FROM core.fact_timekeeping t
CROSS JOIN mart.v_source_precedence p
WHERE t.source NOT IN ('winteam_api', 'winteam_sarus')
  AND NOT (
    p.timekeeping_from IS NOT NULL
    AND t.work_date BETWEEN p.timekeeping_from AND p.timekeeping_to
    AND (cardinality(p.api_companies) = 0 OR t.company IS NULL OR t.company = ANY (p.api_companies))
  )
  AND NOT (
    p.sarus_timekeeping_from IS NOT NULL
    AND t.work_date BETWEEN p.sarus_timekeeping_from AND p.sarus_timekeeping_to
    AND t.company = 'Sarus'
  );

COMMENT ON VIEW mart.v_timekeeping_effective IS
  'core.fact_timekeeping with day-grain source precedence per database: inside each API source''s window [min, max work_date of its rows] only its punches count for the companies it serves (winteam_api: api_companies; winteam_sarus: Sarus); a gap day there is trusted as no punches. Export punches count everywhere else.';

CREATE OR REPLACE VIEW mart.v_ar_invoice_effective AS
SELECT i.ar_invoice_key,
       i.winteam_id,
       i.customer_key,
       i.customer_number,
       i.invoice_number,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_key ELSE i.job_key END AS job_key,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_number ELSE i.job_number END AS job_number,
       i.invoice_date,
       i.posting_date,
       i.billing_period_from,
       i.billing_period_to,
       i.service_month,
       i.terms,
       i.terms_id,
       i.sales_rep,
       i.sales_rep_id,
       i.po_number,
       i.reason,
       i.reason_id,
       i.notes,
       i.tax,
       i.amount_paid,
       i.revenue_total,
       i.invoice_total,
       i.last_date_paid,
       i.collection_status,
       i.invoice_being_credited,
       i.open_balance,
       i.warehouse_loaded_at,
       i.source,
       i.company,
       i.customer_name,
       i.parent_customer_number,
       i.parent_customer_name,
       i.is_collectible,
       i.days_outstanding_snapshot,
       i.aging_bucket_snapshot,
       i.open_balance_basis
FROM core.fact_ar_invoice i
LEFT JOIN mart.v_api_job_map m ON m.raw_job_number = i.job_number
WHERE i.source = 'winteam_api'
UNION ALL
SELECT i.ar_invoice_key,
       i.winteam_id,
       i.customer_key,
       i.customer_number,
       i.invoice_number,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_key ELSE i.job_key END AS job_key,
       CASE WHEN m.raw_job_number IS NOT NULL THEN m.job_number ELSE i.job_number END AS job_number,
       i.invoice_date,
       i.posting_date,
       i.billing_period_from,
       i.billing_period_to,
       i.service_month,
       i.terms,
       i.terms_id,
       i.sales_rep,
       i.sales_rep_id,
       i.po_number,
       i.reason,
       i.reason_id,
       i.notes,
       i.tax,
       i.amount_paid,
       i.revenue_total,
       i.invoice_total,
       i.last_date_paid,
       i.collection_status,
       i.invoice_being_credited,
       i.open_balance,
       i.warehouse_loaded_at,
       i.source,
       i.company,
       i.customer_name,
       i.parent_customer_number,
       i.parent_customer_name,
       i.is_collectible,
       i.days_outstanding_snapshot,
       i.aging_bucket_snapshot,
       i.open_balance_basis
FROM core.fact_ar_invoice i
LEFT JOIN mart.v_sarus_job_map m ON m.raw_job_number = i.job_number
WHERE i.source = 'winteam_sarus'
UNION ALL
SELECT i.ar_invoice_key,
       i.winteam_id,
       i.customer_key,
       i.customer_number,
       i.invoice_number,
       i.job_key,
       i.job_number,
       i.invoice_date,
       i.posting_date,
       i.billing_period_from,
       i.billing_period_to,
       i.service_month,
       i.terms,
       i.terms_id,
       i.sales_rep,
       i.sales_rep_id,
       i.po_number,
       i.reason,
       i.reason_id,
       i.notes,
       i.tax,
       i.amount_paid,
       i.revenue_total,
       i.invoice_total,
       i.last_date_paid,
       i.collection_status,
       i.invoice_being_credited,
       i.open_balance,
       i.warehouse_loaded_at,
       i.source,
       i.company,
       i.customer_name,
       i.parent_customer_number,
       i.parent_customer_name,
       i.is_collectible,
       i.days_outstanding_snapshot,
       i.aging_bucket_snapshot,
       i.open_balance_basis
FROM core.fact_ar_invoice i
WHERE i.source NOT IN ('winteam_api', 'winteam_sarus')
  AND NOT EXISTS (
    SELECT 1 FROM core.fact_ar_invoice a
    WHERE a.source = CASE WHEN i.company = 'Sarus' THEN 'winteam_sarus' ELSE 'winteam_api' END
      AND a.customer_number = i.customer_number AND a.invoice_number = i.invoice_number
  );

COMMENT ON VIEW mart.v_ar_invoice_effective IS
  'core.fact_ar_invoice with invoice-grain source precedence: an API invoice supersedes the export invoice with the same (customer_number, invoice_number) of its own database (company Sarus -> winteam_sarus, otherwise winteam_api); otherwise the union of all sources.';

CREATE OR REPLACE VIEW mart.v_ap_invoice_effective AS
SELECT i.ap_invoice_key,
       i.winteam_id,
       i.vendor_key,
       i.vendor_number,
       i.company_number,
       i.invoice_number,
       i.invoice_date,
       i.posting_date,
       i.due_date,
       i.invoice_amount,
       i.po_number,
       i.notes,
       i.pay_use_tax,
       i.use_tax_amount,
       i.use_tax_code,
       i.payment_plan_id,
       i.payment_method_id,
       i.credit_card_vendor_number,
       i.memo_line_1,
       i.memo_line_2,
       i.permanent_hold,
       i.include_on_1099,
       i.warehouse_loaded_at,
       i.source,
       i.company,
       i.vendor_name,
       i.vendor_type,
       i.amount_paid,
       i.open_balance,
       i.days_past_due,
       i.snapshot_date
FROM core.fact_ap_invoice i
WHERE i.source IN ('winteam_api', 'winteam_sarus')
UNION ALL
SELECT i.ap_invoice_key,
       i.winteam_id,
       i.vendor_key,
       i.vendor_number,
       i.company_number,
       i.invoice_number,
       i.invoice_date,
       i.posting_date,
       i.due_date,
       i.invoice_amount,
       i.po_number,
       i.notes,
       i.pay_use_tax,
       i.use_tax_amount,
       i.use_tax_code,
       i.payment_plan_id,
       i.payment_method_id,
       i.credit_card_vendor_number,
       i.memo_line_1,
       i.memo_line_2,
       i.permanent_hold,
       i.include_on_1099,
       i.warehouse_loaded_at,
       i.source,
       i.company,
       i.vendor_name,
       i.vendor_type,
       i.amount_paid,
       i.open_balance,
       i.days_past_due,
       i.snapshot_date
FROM core.fact_ap_invoice i
CROSS JOIN mart.v_source_precedence p
WHERE i.source NOT IN ('winteam_api', 'winteam_sarus')
  AND NOT (
    p.ap_invoice_from IS NOT NULL
    AND coalesce(i.invoice_date, i.posting_date) BETWEEN p.ap_invoice_from AND p.ap_invoice_to
    AND (cardinality(p.api_companies) = 0 OR i.company IS NULL OR i.company = ANY (p.api_companies))
  )
  AND NOT (
    p.sarus_ap_invoice_from IS NOT NULL
    AND coalesce(i.invoice_date, i.posting_date) BETWEEN p.sarus_ap_invoice_from AND p.sarus_ap_invoice_to
    AND i.company = 'Sarus'
  );

COMMENT ON VIEW mart.v_ap_invoice_effective IS
  'core.fact_ap_invoice with invoice-date source precedence per database: inside each API source''s window only its invoices count for the companies it serves (winteam_api: api_companies; winteam_sarus: Sarus); export invoices count everywhere else.';

CREATE INDEX IF NOT EXISTS fact_ap_distribution_source_idx ON core.fact_ap_distribution (source);
CREATE INDEX IF NOT EXISTS fact_job_budget_source_idx ON core.fact_job_budget (source);

-- Crane punches on a job number both databases use (401, 6325, 99999) were priced at the trailing
-- rate of the Sarus job with that number. Pricing now follows the job the punch resolved to; send
-- those punches back through it (normalize.price_unpriced_punches re-prices anything not on the
-- trailing basis, keeping the API's own rate in source_rate).
UPDATE core.fact_timekeeping t
SET labor_cost_basis = CASE WHEN coalesce(t.source_rate, 0) > 0 THEN 'hours_x_rate' ELSE 'none' END
FROM core.dim_job d
WHERE d.job_key = t.job_key
  AND t.source = 'winteam_api'
  AND t.labor_cost_basis = 'trailing_job_rate'
  AND d.job_number IS DISTINCT FROM t.job_number;
