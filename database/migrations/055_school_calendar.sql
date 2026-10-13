-- 055: school district calendars (app/school_calendar.py), so a district account's weeks show when
-- schools are closed and labor should run lower.
--
-- ops.school_day holds one row per weekday per source. 'scraped' rows come from the district's
-- published calendar, re-read by the nightly sync; a re-read replaces only the scraped rows of the
-- school year it covers (July 1 to June 30). 'manual' rows are Admin overrides and are never touched
-- by a re-read. ops.v_school_day is the calendar in effect: the manual row when there is one, else
-- the scraped row.
--
-- day_type: school | early_release | staff_only (students out, staff in) | holiday (students and
-- staff out, buildings closed) | summer. Weekends are not stored.
--
-- ops.school_calendar_source keeps each district's calendar link and the last read. A district with
-- no row uses the default link in app/school_calendar.py.

CREATE TABLE IF NOT EXISTS ops.school_calendar_source (
  account_slug text PRIMARY KEY,
  url text,
  enabled boolean NOT NULL DEFAULT true,
  content_sha256 text,
  school_year integer,          -- the start year: 2026 is the 2026-27 school year
  days_found integer,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('loaded', 'unchanged', 'failed')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS ops.school_day (
  account_slug text NOT NULL REFERENCES ops.account (slug) ON UPDATE CASCADE ON DELETE CASCADE,
  day date NOT NULL CHECK (extract(isodow FROM day) < 6),
  source text NOT NULL CHECK (source IN ('scraped', 'manual')),
  day_type text NOT NULL CHECK (day_type IN ('school', 'early_release', 'staff_only', 'holiday', 'summer')),
  label text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (account_slug, day, source)
);

CREATE OR REPLACE VIEW ops.v_school_day AS
SELECT DISTINCT ON (account_slug, day) account_slug, day, day_type, label, source
FROM ops.school_day
ORDER BY account_slug, day, (source = 'manual') DESC;

COMMENT ON TABLE ops.school_day IS
  'School district calendar per weekday (app/school_calendar.py). scraped rows are replaced by each read of the district calendar; manual rows are Admin overrides and win (ops.v_school_day).';
