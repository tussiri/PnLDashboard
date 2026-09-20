-- 012: Job-number collisions and the business-unit order (docs/winteam-live-source.md "Precedence").
--
-- 1. Job numbers are only unique within one WinTeam database. 14 numbers the API tenant (Crane)
--    serves are Sarus jobs in the finance_reference load (300 = "Amazon - BDL3/7" in Sarus, "FXE_AGCA
--    Pittsburgh PA" in Crane). 008/011 skipped those API jobs, but API facts still joined dim_job by
--    the bare number and landed on the Sarus row (a Crane invoice's $2,921 replaced BDL3/7's
--    carry-forward invoicing; 1,092 h of Crane punches were attributed to Sarus).
--    Structural rule, applied in ONE place - mart.v_api_job_map, which every effective view and the
--    normalizer's job lookups use:
--      * an API-sourced fact may only resolve to a current dim_job row whose company is one of the
--        tenant's companies (the labels of ops.app_setting.company_numbers; a row without a company
--        counts as the tenant's; an empty setting means every row);
--      * when the bare-number row belongs to another namespace (Sarus), the fact resolves to the
--        namespaced row '<namespace>:<number>' (e.g. 'Crane:300') that normalize.py now creates for
--        the colliding API jobs, mirroring the reference loader's convention of namespacing
--        identities by database ('ar:Sarus:<invoice>', 'fr:Sarus:<vendor>', Sarus vendor offset);
--        the bare number stays the reference (Sarus) job. If no namespaced row exists yet the fact
--        carries the namespaced number with a NULL job_key (visible, never attributed to Sarus);
--      * reference facts keep today's bare-number match.
--    mart.v_timekeeping_effective / v_ar_invoice_effective are recreated with explicit column lists
--    so their job_key / job_number are the resolved ones for API rows (same columns, same order).
--    AP invoices are not job-linked.
-- 2. ops.app_setting.bu_order: the order in which /executive/labor-pl lists business units
--    (unknown units are appended alphabetically; each unit carries sort_order).

INSERT INTO ops.app_setting (key, value, description) VALUES
  ('bu_order', '["Crane West", "Crane IFS", "Crane Southwest", "Sarus"]'::jsonb,
   'Display order of the business units (companies) on the executive labor P&L; units not listed are appended alphabetically.')
ON CONFLICT (key) DO NOTHING;

-- api_namespace appended (same rule as normalize.tenant_namespace: Sarus only when every label is Sarus)
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
     WHERE s.key = 'company_numbers' AND jsonb_typeof(s.value) = 'object' AND btrim(e.value) <> '') AS api_namespace;

CREATE OR REPLACE VIEW mart.v_api_job_map AS
SELECT d.job_number AS raw_job_number,
       c.covered AS bare_row_is_tenant,
       CASE WHEN c.covered THEN d.job_number ELSE p.api_namespace || ':' || d.job_number END AS job_number,
       CASE WHEN c.covered THEN d.job_key ELSE ns.job_key END AS job_key,
       CASE WHEN c.covered THEN d.company ELSE ns.company END AS company,
       d.job_key AS bare_job_key,
       ns.job_key AS namespaced_job_key
FROM core.dim_job d
CROSS JOIN mart.v_source_precedence p
CROSS JOIN LATERAL (
  SELECT (cardinality(p.api_companies) = 0 OR d.company IS NULL OR d.company = ANY (p.api_companies)) AS covered
) c
LEFT JOIN core.dim_job ns
  ON ns.valid_to IS NULL AND ns.job_number = p.api_namespace || ':' || d.job_number
WHERE d.valid_to IS NULL AND d.job_number IS NOT NULL;

COMMENT ON VIEW mart.v_api_job_map IS
  'How an API-sourced fact''s jobNumber resolves to core.dim_job: the bare-number row when its company is one of the tenant''s (company_numbers labels), else the namespaced row api_namespace:number created for job-number collisions (NULL job_key when it does not exist yet).';

CREATE OR REPLACE VIEW mart.v_timekeeping_effective AS
SELECT
       t.timekeeping_key,
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
SELECT t.*
FROM core.fact_timekeeping t
CROSS JOIN mart.v_source_precedence p
WHERE t.source <> 'winteam_api'
  AND NOT (
    p.timekeeping_from IS NOT NULL
    AND t.work_date BETWEEN p.timekeeping_from AND p.timekeeping_to
    AND (cardinality(p.api_companies) = 0 OR t.company IS NULL OR t.company = ANY (p.api_companies))
  );

CREATE OR REPLACE VIEW mart.v_ar_invoice_effective AS
SELECT
       i.ar_invoice_key,
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
SELECT i.*
FROM core.fact_ar_invoice i
WHERE i.source <> 'winteam_api'
  AND NOT EXISTS (
    SELECT 1 FROM core.fact_ar_invoice a
    WHERE a.source = 'winteam_api' AND a.customer_number = i.customer_number AND a.invoice_number = i.invoice_number
  );
