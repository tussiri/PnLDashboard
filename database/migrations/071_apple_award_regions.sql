-- 071: subregions from a site's address, segments from the subregion, and the store award on contracts.
--
-- ops.subregion_rule names a subregion from a site's state and ZIP code, per account (account_slug NULL = any
-- account). The first matching rule by sort wins; a site no rule matches keeps its state. An Admin override in
-- ops.site_region still wins over both. Apple's California stores split at ZIP 93600 (SoCal up to 935xx, NorCal
-- from 936xx), the line the Apple award uses for every one of its 23 California stores.
--
-- segment_source 'subregion' groups an account's sites by their subregion in effect: a subregion that is one of
-- the account's segments is the segment, any other is the fallback segment.
--
-- ops.job_contract gains nte_hours (the not-to-exceed hours per month) and bill_rate, from the store award
-- (app/award.py). monthly_amount stays the flat monthly revenue the contract invoice basis reads.

CREATE TABLE IF NOT EXISTS ops.subregion_rule (
  rule_id serial PRIMARY KEY,
  account_slug text REFERENCES ops.account (slug) ON UPDATE CASCADE ON DELETE CASCADE,
  state text NOT NULL CHECK (btrim(state) <> ''),
  postal_from text CHECK (postal_from ~ '^\d{5}$'),
  postal_to text CHECK (postal_to ~ '^\d{5}$'),
  subregion text NOT NULL CHECK (btrim(subregion) <> ''),
  sort integer NOT NULL DEFAULT 100,
  CHECK ((postal_from IS NULL) = (postal_to IS NULL) AND (postal_from IS NULL OR postal_from <= postal_to))
);

COMMENT ON TABLE ops.subregion_rule IS
  'Subregion from a site''s state and 5-digit ZIP (inclusive range; none = the whole state), per account or any (NULL). First match by sort wins.';

CREATE OR REPLACE FUNCTION ops.rule_subregion(p_account text, p_state text, p_postal text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT r.subregion
  FROM ops.subregion_rule r
  WHERE (r.account_slug IS NULL OR r.account_slug = p_account)
    AND upper(btrim(r.state)) = upper(btrim(p_state))
    AND (r.postal_from IS NULL OR left(regexp_replace(coalesce(p_postal, ''), '\D', '', 'g'), 5) BETWEEN r.postal_from AND r.postal_to)
  ORDER BY r.account_slug IS NULL, r.sort, r.rule_id
  LIMIT 1
$$;

-- The subregion in effect: the Admin override, else the account's rule, else the WinTeam state.
CREATE OR REPLACE FUNCTION ops.site_subregion(p_account text, p_override text, p_state text, p_postal text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(p_override, ops.rule_subregion(p_account, p_state, p_postal), nullif(btrim(p_state), ''))
$$;

-- The segment in effect for a mapped job: under segment_source 'subregion' the subregion when it is one of the
-- account's segments, else the fallback; otherwise the job's own segment, else the fallback. NULL off the site role.
CREATE OR REPLACE FUNCTION ops.segment_in_effect(p_account text, p_role text, p_segment text, p_subregion text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_role = 'site' THEN
           CASE WHEN a.segment_source = 'subregion'
                THEN coalesce((SELECT s.name FROM ops.account_segment s WHERE s.account_slug = a.slug AND s.name = p_subregion), a.fallback_segment)
                ELSE coalesce(p_segment, a.fallback_segment) END
         END
  FROM ops.account a WHERE a.slug = p_account
$$;

CREATE OR REPLACE VIEW ops.v_site_region AS
SELECT j.company, j.job_number, j.job_name, j.is_active, aj.account_slug,
       nullif(btrim(j.region_name), '') AS winteam_region,
       nullif(btrim(j.state_province), '') AS winteam_subregion,
       sr.region AS region_override, sr.subregion AS subregion_override,
       coalesce(sr.region, nullif(btrim(j.region_name), '')) AS region,
       ops.site_subregion(aj.account_slug, sr.subregion, j.state_province, j.postal_code) AS subregion,
       sr.updated_at, sr.updated_by,
       ops.rule_subregion(aj.account_slug, j.state_province, j.postal_code) AS rule_subregion
FROM core.dim_job j
LEFT JOIN ops.site_region sr ON sr.company = j.company AND sr.job_number = j.job_number
LEFT JOIN ops.account_job aj ON aj.company = j.company AND aj.job_number = j.job_number
WHERE j.valid_to IS NULL AND j.company IS NOT NULL AND j.job_number IS NOT NULL;

ALTER TABLE ops.account DROP CONSTRAINT IF EXISTS account_segment_source_check;
ALTER TABLE ops.account ADD CONSTRAINT account_segment_source_check
  CHECK (segment_source IN ('explicit', 'sub_account', 'company', 'fallback', 'subregion'));

ALTER TABLE ops.job_contract ADD COLUMN IF NOT EXISTS nte_hours numeric(12, 2) CHECK (nte_hours IS NULL OR nte_hours >= 0);
ALTER TABLE ops.job_contract ADD COLUMN IF NOT EXISTS bill_rate numeric(12, 4) CHECK (bill_rate IS NULL OR bill_rate >= 0);
COMMENT ON COLUMN ops.job_contract.nte_hours IS 'Not-to-exceed hours per month (the store award), null when the contract has none.';

-- Apple: California by ZIP, Florida and Georgia by state.
INSERT INTO ops.subregion_rule (account_slug, state, postal_from, postal_to, subregion, sort)
SELECT 'apple-retail', v.state, v.lo, v.hi, v.name, v.sort
FROM (VALUES ('CA', '90000', '93599', 'SoCal', 1), ('CA', '93600', '96199', 'NorCal', 2),
             ('FL', NULL, NULL, 'Florida', 3), ('GA', NULL, NULL, 'Georgia', 4)) AS v(state, lo, hi, name, sort)
WHERE EXISTS (SELECT 1 FROM ops.account WHERE slug = 'apple-retail')
  AND NOT EXISTS (SELECT 1 FROM ops.subregion_rule WHERE account_slug = 'apple-retail');

-- Apple's weekly report: the self-performed stores by subregion (labor target 62% in California, 67% in Florida
-- and Georgia), the subcontracted stores on their own tab, and the flat monthly award ÷ 4.33 as the weekly invoice.
INSERT INTO ops.account_segment (account_slug, name, sort, target_labor_pct)
SELECT 'apple-retail', v.name, v.sort, v.target
FROM (VALUES ('SoCal', 1, 0.62), ('NorCal', 2, 0.62), ('Florida', 3, 0.67), ('Georgia', 4, 0.67), ('Other', 5, NULL::numeric)) AS v(name, sort, target)
WHERE EXISTS (SELECT 1 FROM ops.account WHERE slug = 'apple-retail')
ON CONFLICT (account_slug, name) DO NOTHING;

UPDATE ops.account
SET segment_source = 'subregion', fallback_segment = 'Other', segment_label = 'Region', split_subcontracted = true,
    invoice_basis = 'contract', revenue_divisor = 4.33, updated_at = now(), updated_by = 'migration 071'
WHERE slug = 'apple-retail' AND segment_source = 'fallback' AND fallback_segment = 'Stores';

UPDATE ops.account_job SET segment = 'Other' WHERE account_slug = 'apple-retail' AND segment = 'Stores'
  AND EXISTS (SELECT 1 FROM ops.account WHERE slug = 'apple-retail' AND fallback_segment = 'Other');
DELETE FROM ops.account_segment WHERE account_slug = 'apple-retail' AND name = 'Stores'
  AND EXISTS (SELECT 1 FROM ops.account WHERE slug = 'apple-retail' AND fallback_segment = 'Other');
