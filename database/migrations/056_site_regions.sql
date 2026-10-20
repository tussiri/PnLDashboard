-- 056: region and subregion of sites and accounts.
--
-- A site's region comes from WinTeam (core.dim_job.region_name, job tier 3 in the Crane tenant:
-- Southeast, Southwest, Midwest...) and its subregion from the site's state. ops.site_region holds
-- Admin overrides of either; a NULL field keeps the WinTeam value. ops.v_site_region is the region in
-- effect for every current job.
--
-- ops.account.region / subregion name an account's home region. When NULL the dashboard derives it
-- from the account's sites (their one region, or "Multi-region").

CREATE TABLE IF NOT EXISTS ops.site_region (
  company text NOT NULL,
  job_number text NOT NULL,
  region text CHECK (region IS NULL OR btrim(region) <> ''),
  subregion text CHECK (subregion IS NULL OR btrim(subregion) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (company, job_number),
  CHECK (region IS NOT NULL OR subregion IS NOT NULL)
);

COMMENT ON TABLE ops.site_region IS
  'Admin overrides of a site''s region and subregion. NULL keeps the WinTeam value (dim_job.region_name, dim_job.state_province).';

ALTER TABLE ops.account ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE ops.account ADD COLUMN IF NOT EXISTS subregion text;

CREATE OR REPLACE VIEW ops.v_site_region AS
SELECT j.company, j.job_number, j.job_name, j.is_active, aj.account_slug,
       nullif(btrim(j.region_name), '') AS winteam_region,
       nullif(btrim(j.state_province), '') AS winteam_subregion,
       sr.region AS region_override, sr.subregion AS subregion_override,
       coalesce(sr.region, nullif(btrim(j.region_name), '')) AS region,
       coalesce(sr.subregion, nullif(btrim(j.state_province), '')) AS subregion,
       sr.updated_at, sr.updated_by
FROM core.dim_job j
LEFT JOIN ops.site_region sr ON sr.company = j.company AND sr.job_number = j.job_number
LEFT JOIN ops.account_job aj ON aj.company = j.company AND aj.job_number = j.job_number
WHERE j.valid_to IS NULL AND j.company IS NOT NULL AND j.job_number IS NOT NULL;
