-- 041: PhotoValidation staffing requests (app/sources/photovalidation.py, app/staffing.py).
--
-- A site admin states in PhotoValidation what a building needs, by shift; HR approves the line and
-- opens the role in Hire. PhotoValidation serves one row per request line at
-- GET /api/v1/staffing-requests (Contract B, PhotoValidation docs/specs/staffing-intake.md). The
-- connector pulls it incrementally (updatedSince = the largest updated_at held here) and upserts by
-- line_id. Numbered 041 to stay clear of 036-040 on the leadership branch.
--
-- The site key is the WinTeam job number together with the WinTeam database ('Crane' | 'Sarus').
-- job_key is resolved on every pull and every mart rebuild: 'Crane' through mart.v_api_job_map (the
-- primary tenant's map; never a Sarus row, falling back to the namespaced 'Crane:<n>' row), 'Sarus'
-- through mart.v_sarus_job_map. NULL when the site is unmapped in PhotoValidation or the job is unknown
-- here. No foreign key: a reference reload can re-key core.dim_job, and the next resolution follows it.
--
-- Values are kept as PhotoValidation sends them (no CHECK constraints), so a value the contract adds
-- later cannot fail a whole page; the mart counts only the statuses it knows.

CREATE TABLE IF NOT EXISTS core.fact_staffing_request (
  line_id text PRIMARY KEY,
  request_id text NOT NULL,
  request_code text,
  location_id text,
  site_name text,
  account_name text,
  winteam_job_number text,
  winteam_company text,
  job_key bigint,
  role text,
  shift text,                  -- day | swing | night | weekend | other
  shift_start text,            -- 'HH:MM', local to the site
  shift_end text,
  headcount_needed integer NOT NULL DEFAULT 0,
  current_filled integer,
  reason text,                 -- backfill | growth | new_contract | coverage
  employment_type text,        -- full_time | part_time
  hours_per_week numeric(6, 2),
  pay_rate numeric(10, 2),
  needed_by date,
  status text NOT NULL,        -- submitted | approved | posted | filled | rejected | cancelled
  hire_job_id text,
  reported_headcount integer,
  submitted_at timestamptz,
  decided_at timestamptz,
  posted_at timestamptz,
  filled_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  warehouse_loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_staffing_request_job_idx ON core.fact_staffing_request (job_key) WHERE job_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS fact_staffing_request_site_idx ON core.fact_staffing_request (winteam_company, winteam_job_number);
CREATE INDEX IF NOT EXISTS fact_staffing_request_updated_idx ON core.fact_staffing_request (updated_at);

COMMENT ON TABLE core.fact_staffing_request IS
  'PhotoValidation staffing request lines (Contract B), upserted by line_id. Active demand = approved | posted; pending = submitted. pay_rate is the requested hourly rate.';

-- Weekly demand per site. NULL until the feed has loaded once; then the headcount open at the end of
-- the week (at now() for the week in progress), rebuilt with the mart and refreshed after every pull.
ALTER TABLE mart.job_week ADD COLUMN IF NOT EXISTS requested_headcount integer;
ALTER TABLE mart.job_week ADD COLUMN IF NOT EXISTS pending_requested_headcount integer;

COMMENT ON COLUMN mart.job_week.requested_headcount IS
  'Sum of headcount_needed over PhotoValidation request lines approved or posted at the end of the week (now() for the week in progress). NULL before the feed first loads.';
COMMENT ON COLUMN mart.job_week.pending_requested_headcount IS
  'Sum of headcount_needed over PhotoValidation request lines still awaiting a decision (submitted) at the end of the week (now() for the week in progress). NULL before the feed first loads.';
