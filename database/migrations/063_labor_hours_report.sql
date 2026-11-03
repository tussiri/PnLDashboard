-- 063: the labor hours report (app/labor_hours.py, permission report.labor-hours).
--
-- The live timekeeping API sends inTime/outTime as a time of day ("07:29:00"), not the documented
-- date-time, so normalize.stamp() turned every one into NULL. The parser now reads both forms; this
-- recovers the punches already loaded, from the raw payloads. A time of day is wall clock at the site,
-- stored as UTC like the export's clock times, and an out time before the in time ran past midnight.

INSERT INTO ops.app_setting (key, value, description) VALUES
  ('labor_report_states', '["CA"]'::jsonb,
   'States (dim_job.state_province) whose sites the labor hours report covers.'),
  ('timekeeping_category_labels',
   '{"1":"Ops/Regular","87":"Ops/Regular","104":"Ops/Regular","4":"Ops/PSL","107":"Ops/PSL","123":"Ops/PSL","6":"Ops/Vacation","109":"Ops/Vacation","125":"Ops/Vacation","5":"Ops/Training","58":"Admin/Regular","136":"FedEx/Pallet","152":"FedEx/Handyman"}'::jsonb,
   'Hours type names of the timekeeping API''s categoryDetailId values, matched against the export''s HoursTypeDescription on identical punches.')
ON CONFLICT (key) DO NOTHING;

WITH clock AS (
  SELECT tenant.id_prefix || r.source_record_id AS winteam_id,
         CASE WHEN r.payload->>'inTime' ~ '^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$' THEN (r.payload->>'inTime')::time END AS clock_in,
         CASE WHEN r.payload->>'outTime' ~ '^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$' THEN (r.payload->>'outTime')::time END AS clock_out
  FROM (VALUES ('timekeeping', 'api:'), ('sarus/timekeeping', 'api:sarus:')) AS tenant(resource_name, id_prefix)
  JOIN raw.v_winteam_current r ON r.resource_name = tenant.resource_name
)
UPDATE core.fact_timekeeping t
SET in_time = coalesce(t.in_time, (t.work_date + c.clock_in) AT TIME ZONE 'UTC'),
    out_time = coalesce(t.out_time, (t.work_date + c.clock_out + CASE WHEN c.clock_out < c.clock_in THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE 'UTC')
FROM clock c
WHERE t.winteam_id = c.winteam_id
  AND t.source IN ('winteam_api', 'winteam_sarus')
  AND ((t.in_time IS NULL AND c.clock_in IS NOT NULL) OR (t.out_time IS NULL AND c.clock_out IS NOT NULL));
