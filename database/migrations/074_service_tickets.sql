-- 074: FedEx service tickets (escalations) from the account team's tracker workbook ("FX Service Tickets.xlsx",
-- sheet Service Tickets), imported as kind 'service_ticket' (app/service_tickets.py). One row per ticket; a ticket
-- loaded again replaces its row, tickets missing from a later file are kept. Location # is the FedEx location
-- (an Express code such as "BWIA" or a Ground station number such as 61), matched to a WinTeam job the way the
-- ServiceChannel feedback is: Relay's ServiceChannel location id, else a job named "FedEx - <location>", comparing
-- upper case without leading zeros (core.feedback_location). A ticket naming several locations ("ATLR & FOPRT") matches
-- on the first; location_label keeps the cell as written.

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_kind_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_kind_check
  CHECK (kind IN ('pay_report', 'job_cost', 'income_statement', 'service_feedback', 'qa_score', 'budget',
                  'job_income_statement', 'contract', 'service_ticket'));

CREATE TABLE IF NOT EXISTS core.fact_service_ticket (
  ticket_number text PRIMARY KEY,
  status text,
  assigned_to text,
  opco text,
  location_number text NOT NULL,
  location_label text,
  city_state text,
  provider text,
  issue_type text,
  escalation_level text,
  date_received date,
  date_acknowledged date,
  date_closed date,
  expected_close date,
  notes text,
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_service_ticket_location_idx ON core.fact_service_ticket (core.feedback_location(location_number));

CREATE OR REPLACE VIEW mart.v_service_ticket AS
WITH relay AS (
  SELECT DISTINCT ON (core.feedback_location(sc_location_id)) core.feedback_location(sc_location_id) AS location, winteam_job_number AS job_number,
         site_name AS relay_site_name
  FROM core.relay_site
  WHERE sc_location_id IS NOT NULL AND winteam_job_number IS NOT NULL
  ORDER BY core.feedback_location(sc_location_id), (service_kind = 'janitorial') DESC, relay_id
),
named AS (
  SELECT DISTINCT ON (core.feedback_location(t.location_number)) core.feedback_location(t.location_number) AS location, j.job_number
  FROM core.fact_service_ticket t
  JOIN core.dim_job j ON j.valid_to IS NULL
   AND (upper(j.job_name) = 'FEDEX - ' || core.feedback_location(t.location_number)
        OR upper(j.job_name) LIKE 'FEDEX - ' || core.feedback_location(t.location_number) || ' %')
  ORDER BY core.feedback_location(t.location_number), j.job_number
)
SELECT t.ticket_number, t.status, t.assigned_to, t.opco, t.location_number, t.location_label, t.city_state, t.provider, t.issue_type,
       t.escalation_level, t.date_received, t.date_acknowledged, t.date_closed, t.expected_close, t.notes, t.import_file_id,
       j.company, coalesce(r.job_number, n.job_number) AS job_number, coalesce(j.job_name, r.relay_site_name) AS site_name,
       j.account_slug, CASE WHEN r.job_number IS NOT NULL THEN 'relay' WHEN n.job_number IS NOT NULL THEN 'job_name' END AS match_basis
FROM core.fact_service_ticket t
LEFT JOIN relay r ON r.location = core.feedback_location(t.location_number)
LEFT JOIN named n ON n.location = core.feedback_location(t.location_number)
LEFT JOIN LATERAL (
  SELECT d.company, d.job_number, d.job_name, m.account_slug FROM core.dim_job d
  LEFT JOIN ops.account_job m ON m.company = d.company AND m.job_number = d.job_number
  WHERE d.valid_to IS NULL AND d.job_number = coalesce(r.job_number, n.job_number)
    AND (r.job_number IS NULL OR d.company IS DISTINCT FROM 'Sarus')
  ORDER BY (m.account_slug IS NOT NULL) DESC, d.company LIMIT 1
) j ON true;
