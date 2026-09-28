-- 034: Relay (integration_mapper) feeds for FedEx (app/relay.py, Relay docs/DASHBOARD_EXPORT.md).
--
-- Relay knows what only it knows about FedEx: every subcontractor payable with its WinTeam job and
-- service month, FedEx AR with supersession applied, which stations are Crane's own work, and the
-- monthly contract amounts. The dashboard pulls Relay's read-only export and keeps a full snapshot
-- of each feed here, replaced on every sync, so a payable Relay removes disappears here too.
-- The weekly leadership mart reads these for the jobs Relay covers (app/leadership.py).

CREATE TABLE IF NOT EXISTS core.relay_ap_payable (
  relay_id bigint PRIMARY KEY,
  winteam_job_number text,
  job_source text,
  service_month date,
  station text,
  subtype text,
  correlation_key text,
  vendor_number text,
  vendor_name text,
  vendor_invoice_number text,
  work_order_number text,
  is_placeholder boolean NOT NULL DEFAULT false,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  ar_invoice_number text,
  status text,
  in_winteam boolean NOT NULL DEFAULT false,
  winteam_ref text,
  payment_status text,
  paid_amount numeric(14, 2),
  paid_date date,
  check_number text,
  self_perform boolean NOT NULL DEFAULT false,
  recorded_at timestamptz,
  pushed_at timestamptz,
  relay_updated_at timestamptz,
  payload jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_ap_job_month_idx ON core.relay_ap_payable (winteam_job_number, service_month);

CREATE TABLE IF NOT EXISTS core.relay_ar_invoice (
  relay_id bigint PRIMARY KEY,
  invoice_number text NOT NULL,
  customer_number text,
  winteam_job_number text,
  site_name text,
  service_month date,
  invoice_date date,
  revenue_before_tax numeric(14, 2) NOT NULL DEFAULT 0,
  tax numeric(14, 2),
  portal_state text,
  remitted_amount numeric(14, 2),
  paid_date date,
  relay_updated_at timestamptz,
  payload jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_ar_job_month_idx ON core.relay_ar_invoice (winteam_job_number, service_month);

CREATE TABLE IF NOT EXISTS core.relay_site (
  relay_id bigint PRIMARY KEY,
  station text,
  sc_location_id text,
  winteam_job_number text NOT NULL,
  service_kind text,
  site_name text,
  self_perform boolean NOT NULL DEFAULT false,
  subcontractor text,
  ar_monthly numeric(14, 2),
  ap_monthly numeric(14, 2),
  billing_portal text,
  has_contract boolean NOT NULL DEFAULT false,
  relay_updated_at timestamptz,
  payload jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_site_job_idx ON core.relay_site (winteam_job_number);

CREATE TABLE IF NOT EXISTS core.relay_work_order (
  relay_id bigint PRIMARY KEY,
  correlation_key text,
  station text,
  subtype text,
  service_month date,
  winteam_job_number text,
  work_order_number text,
  status text,
  ap_not_to_exceed numeric(14, 2),
  customer_not_to_exceed numeric(14, 2),
  relay_updated_at timestamptz,
  payload jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);

-- Per job and service month: Relay's subcontractor cost (self-perform legs excluded: that cost is
-- payroll, not a payable), what Relay has billed FedEx, and the contract amounts of the job's sites.
CREATE OR REPLACE VIEW mart.v_relay_job_month AS
WITH ap AS (
  SELECT winteam_job_number, service_month, sum(amount) AS ap_amount, count(*) AS payables,
         count(*) FILTER (WHERE NOT in_winteam) AS payables_not_in_winteam
  FROM core.relay_ap_payable
  WHERE NOT self_perform AND winteam_job_number IS NOT NULL AND service_month IS NOT NULL
  GROUP BY 1, 2
),
ar AS (
  SELECT winteam_job_number, service_month, sum(revenue_before_tax) AS ar_revenue, count(*) AS invoices
  FROM core.relay_ar_invoice
  WHERE winteam_job_number IS NOT NULL AND service_month IS NOT NULL
  GROUP BY 1, 2
)
SELECT coalesce(ap.winteam_job_number, ar.winteam_job_number) AS job_number,
       coalesce(ap.service_month, ar.service_month) AS month,
       coalesce(ap.ap_amount, 0) AS ap_amount, coalesce(ap.payables, 0) AS payables,
       coalesce(ap.payables_not_in_winteam, 0) AS payables_not_in_winteam,
       ar.ar_revenue, coalesce(ar.invoices, 0) AS ar_invoices
FROM ap FULL JOIN ar ON ar.winteam_job_number = ap.winteam_job_number AND ar.service_month = ap.service_month;

CREATE OR REPLACE VIEW mart.v_relay_job_contract AS
SELECT winteam_job_number AS job_number,
       bool_or(self_perform) AS self_perform,
       sum(ap_monthly) FILTER (WHERE NOT self_perform) AS ap_monthly,
       sum(ar_monthly) AS ar_monthly,
       count(*) AS stations
FROM core.relay_site
GROUP BY winteam_job_number;
