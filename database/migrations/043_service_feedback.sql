-- 043: customer feedback and star ratings per work order (the ServiceChannel feedback export FedEx
-- sends), imported as kind 'service_feedback' (app/imports.py). One row per work order; a re-sent
-- work order replaces its row. Location Number is the ServiceChannel location id, which Relay maps
-- to a WinTeam job (core.relay_site.sc_location_id -> winteam_job_number).

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_kind_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_kind_check
  CHECK (kind IN ('pay_report', 'job_cost', 'income_statement', 'service_feedback'));

CREATE TABLE IF NOT EXISTS core.fact_service_feedback (
  wo_number text PRIMARY KEY,
  location_number text NOT NULL,
  provider_name text,
  trade text,
  feedback text,
  feedback_date date NOT NULL,
  comment text,
  score numeric(4, 2),
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_service_feedback_location_idx ON core.fact_service_feedback (upper(location_number));
CREATE INDEX IF NOT EXISTS fact_service_feedback_date_idx ON core.fact_service_feedback (feedback_date);

-- Each feedback row with its WinTeam job: the Relay site for the location (janitorial first, as the
-- feedback is for janitorial trades), else a FedEx job named "FedEx - <location> ...". Unmatched rows
-- keep a null job and are listed as such.
CREATE OR REPLACE VIEW mart.v_service_feedback AS
WITH relay AS (
  SELECT DISTINCT ON (upper(sc_location_id)) upper(sc_location_id) AS location, winteam_job_number AS job_number
  FROM core.relay_site
  WHERE sc_location_id IS NOT NULL AND winteam_job_number IS NOT NULL
  ORDER BY upper(sc_location_id), (service_kind = 'janitorial') DESC, relay_id
),
named AS (
  SELECT DISTINCT ON (upper(f.location_number)) upper(f.location_number) AS location, j.job_number
  FROM core.fact_service_feedback f
  JOIN core.dim_job j ON j.valid_to IS NULL
   AND (upper(j.job_name) = 'FEDEX - ' || upper(f.location_number) OR upper(j.job_name) LIKE 'FEDEX - ' || upper(f.location_number) || ' %')
  ORDER BY upper(f.location_number), j.job_number
)
SELECT f.wo_number, f.location_number, f.provider_name, f.trade, f.feedback, f.feedback_date, f.comment, f.score,
       f.import_file_id, j.company, coalesce(r.job_number, n.job_number) AS job_number, j.job_name AS site_name,
       j.account_slug, CASE WHEN r.job_number IS NOT NULL THEN 'relay' WHEN n.job_number IS NOT NULL THEN 'job_name' END AS match_basis
FROM core.fact_service_feedback f
LEFT JOIN relay r ON r.location = upper(f.location_number)
LEFT JOIN named n ON n.location = upper(f.location_number)
-- A job number can exist in more than one company; prefer the one mapped to an account.
LEFT JOIN LATERAL (
  SELECT d.company, d.job_number, d.job_name, m.account_slug FROM core.dim_job d
  LEFT JOIN ops.account_job m ON m.company = d.company AND m.job_number = d.job_number
  WHERE d.valid_to IS NULL AND d.job_number = coalesce(r.job_number, n.job_number)
  ORDER BY (m.account_slug IS NOT NULL) DESC, d.company LIMIT 1
) j ON true;
