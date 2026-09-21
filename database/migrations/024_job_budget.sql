-- 024: job budgets from the API - budgeted hours per day of week and the rate behind them.
--
-- This tenant's gl-budgets endpoint returns nothing (2,772 of 2,808 job-years answer 400, the rest
-- come back with empty details), so budget hours and dollars had only two export-fed sources:
-- fact_labor_budget_month, and a daily budget that stopped feeding in July 2026. Whole Foods and
-- most school districts had no budget at all, which is the one field of the executives' original
-- Labor P&L this platform could not reproduce.
--
-- GET /jobs/v2/api/jobs/{jobKey}/budgets does return it, per day of week:
--
--   details[].hours.dayOfWeek = {sun..sat, hol}   details[].rates = {billRate, payRate}
--
-- Day-of-week granularity apportions to a week exactly, with no proration - better for a weekly
-- dashboard than a monthly figure. `hol` is kept separate because a week containing a holiday is
-- not a normal week. A job carries several revisions; effective_date/end_date select the one in
-- force for a given week.
CREATE TABLE IF NOT EXISTS core.fact_job_budget (
  job_budget_key       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source               text NOT NULL DEFAULT 'winteam_api',
  job_number           text NOT NULL,
  job_key              bigint REFERENCES core.dim_job (job_key),
  budget_id            integer NOT NULL,
  line_index           integer NOT NULL,
  effective_date       date,
  end_date             date,
  status               text,
  description          text,
  hours_type           integer,
  salaried             boolean,
  bill_rate            numeric(12,4),
  pay_rate             numeric(12,4),
  hours_sun            numeric(12,2),
  hours_mon            numeric(12,2),
  hours_tue            numeric(12,2),
  hours_wed            numeric(12,2),
  hours_thu            numeric(12,2),
  hours_fri            numeric(12,2),
  hours_sat            numeric(12,2),
  hours_hol            numeric(12,2),
  warehouse_updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, job_number, budget_id, line_index)
);

CREATE INDEX IF NOT EXISTS job_budget_job_idx ON core.fact_job_budget (job_number, effective_date DESC);
CREATE INDEX IF NOT EXISTS job_budget_job_key_idx ON core.fact_job_budget (job_key);

-- Budgeted hours and dollars for one job on one weekday, collapsed across the budget's lines.
-- dow follows Postgres EXTRACT(dow): 0 = Sunday. The holiday column is exposed separately rather
-- than folded in, so a caller decides whether a holiday week uses it.
CREATE OR REPLACE VIEW mart.v_job_budget_day AS
SELECT b.job_number, b.job_key, b.effective_date, b.end_date,
       d.dow,
       sum(d.hours)                        AS budget_hours,
       sum(d.hours * coalesce(b.pay_rate, 0)) AS budget_dollars,
       sum(b.hours_hol)                    AS holiday_hours
FROM core.fact_job_budget b
CROSS JOIN LATERAL (VALUES
  (0, b.hours_sun), (1, b.hours_mon), (2, b.hours_tue), (3, b.hours_wed),
  (4, b.hours_thu), (5, b.hours_fri), (6, b.hours_sat)
) AS d(dow, hours)
WHERE d.hours IS NOT NULL
GROUP BY b.job_number, b.job_key, b.effective_date, b.end_date, d.dow;
