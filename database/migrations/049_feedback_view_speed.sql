-- 049: mart.v_service_feedback, same rows, read in milliseconds instead of 1.6 s. The job-name fallback
-- (a location Relay does not map, matched to a job named "FedEx - <location>") now runs once per
-- distinct location without a Relay match instead of for every rating against every job.

CREATE OR REPLACE VIEW mart.v_service_feedback AS
WITH relay AS MATERIALIZED (
  SELECT DISTINCT ON (core.feedback_location(sc_location_id)) core.feedback_location(sc_location_id) AS location, winteam_job_number AS job_number,
         site_name AS relay_site_name
  FROM core.relay_site
  WHERE sc_location_id IS NOT NULL AND winteam_job_number IS NOT NULL
  ORDER BY core.feedback_location(sc_location_id), (service_kind = 'janitorial') DESC, relay_id
),
locations AS MATERIALIZED (
  SELECT DISTINCT core.feedback_location(location_number) AS location FROM core.fact_service_feedback
),
named AS MATERIALIZED (
  -- Job-name fallback, per distinct location and only where Relay has no match: comparing every rating
  -- with every job made the view take 1.6 s on each read.
  SELECT DISTINCT ON (l.location) l.location, j.job_number
  FROM locations l
  JOIN core.dim_job j ON j.valid_to IS NULL
   AND (upper(j.job_name) = 'FEDEX - ' || l.location OR upper(j.job_name) LIKE 'FEDEX - ' || l.location || ' %')
  WHERE NOT EXISTS (SELECT 1 FROM relay r WHERE r.location = l.location)
  ORDER BY l.location, j.job_number
)
SELECT f.wo_number, f.location_number, f.provider_name, f.trade, f.feedback, f.feedback_date,
       CASE WHEN regexp_replace(lower(coalesce(f.comment, '')), '[^a-z0-9]', '', 'g') IN ('', 'nocomment', 'nocomments', 'na', 'none')
            THEN NULL ELSE f.comment END AS comment, f.score,
       f.import_file_id, j.company, coalesce(r.job_number, n.job_number) AS job_number, coalesce(j.job_name, r.relay_site_name) AS site_name,
       j.account_slug, CASE WHEN r.job_number IS NOT NULL THEN 'relay' WHEN n.job_number IS NOT NULL THEN 'job_name' END AS match_basis
FROM core.fact_service_feedback f
LEFT JOIN relay r ON r.location = core.feedback_location(f.location_number)
LEFT JOIN named n ON n.location = core.feedback_location(f.location_number)
-- A job number can exist in more than one company; prefer the one mapped to an account. Relay is Crane's
-- FedEx system, so a Relay match never resolves to a Sarus job (as in mart.leadership_week).
LEFT JOIN LATERAL (
  SELECT d.company, d.job_number, d.job_name, m.account_slug FROM core.dim_job d
  LEFT JOIN ops.account_job m ON m.company = d.company AND m.job_number = d.job_number
  WHERE d.valid_to IS NULL AND d.job_number = coalesce(r.job_number, n.job_number)
    AND (r.job_number IS NULL OR d.company IS DISTINCT FROM 'Sarus')
  ORDER BY (m.account_slug IS NOT NULL) DESC, d.company LIMIT 1
) j ON true;
