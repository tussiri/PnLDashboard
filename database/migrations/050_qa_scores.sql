-- 050: weekly QA audit scores per site (Amazon's site QA, 0-100), imported as kind 'qa_score'
-- (app/imports.py). One row per site code and week (the Monday the week starts); a re-sent week
-- replaces its score. Site codes are the account's own ("LGB3", "BDL3/7") and match a WinTeam job named
-- "<Account> - <code>"; scores for sites outside Crane (Elite) are kept but match no job.

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_kind_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_kind_check
  CHECK (kind IN ('pay_report', 'job_cost', 'income_statement', 'service_feedback', 'qa_score'));

CREATE TABLE IF NOT EXISTS core.fact_qa_score (
  site_code text NOT NULL,
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  score numeric(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_code, week_start)
);

-- Each score with its job: a job mapped to an account whose name ends in " - <site code>".
CREATE OR REPLACE VIEW mart.v_qa_score AS
WITH codes AS MATERIALIZED (SELECT DISTINCT upper(btrim(site_code)) AS code FROM core.fact_qa_score),
matched AS MATERIALIZED (
  SELECT DISTINCT ON (c.code) c.code, aj.company, aj.job_number, aj.account_slug, j.job_name
  FROM codes c
  JOIN core.dim_job j ON j.valid_to IS NULL AND upper(j.job_name) LIKE '% - ' || c.code
  JOIN ops.account_job aj ON aj.company = j.company AND aj.job_number = j.job_number
  ORDER BY c.code, aj.company, aj.job_number
)
SELECT q.site_code, q.week_start, q.score, q.import_file_id, m.company, m.job_number, m.account_slug, m.job_name AS site_name
FROM core.fact_qa_score q
LEFT JOIN matched m ON m.code = upper(btrim(q.site_code));
