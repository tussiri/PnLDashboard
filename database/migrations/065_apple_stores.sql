-- 065: the Apple stores. WinTeam lists them as jobs "Apple - R550 - Valley Plaza" starting 2026-11-01, each under
-- its own parent account and with no AR customer, so the Apple account group (customer terms only) never matched
-- them and ops.account 'apple-retail' had no jobs.
--
-- The group gets a job-name term and moves first, because other groups' terms ("plano", "henderson") can occur in
-- a store's name. 'apple - r' does not match Appleton. Jobs regroup at the next jobs normalization and map into the
-- account at the next mart rebuild (accounts.auto_assign, source_parent_accounts).
UPDATE ops.app_setting s
SET value = jsonb_build_array(
      coalesce((SELECT e FROM jsonb_array_elements(s.value) e WHERE e->>'name' = 'Apple' LIMIT 1),
               '{"name": "Apple", "job_numbers": [], "customer_terms": ["apple inc", "apple, inc", "apple computer"]}'::jsonb)
      || '{"terms": ["apple - r"]}'::jsonb)
    || coalesce((SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(s.value) WITH ORDINALITY t(e, o) WHERE e->>'name' <> 'Apple'), '[]'::jsonb),
    updated_at = now()
WHERE s.key = 'account_groups' AND jsonb_typeof(s.value) = 'array';

-- Fifty-nine of the stores are subcontracted, so the account's cost carries vendor invoices.
UPDATE ops.account
SET source_parent_accounts = ARRAY['Apple'], featured = true, cost_basis = 'labor_plus_vendor', vendor_label = 'Subcontractor', updated_at = now()
WHERE slug = 'apple-retail';

-- dim_job.delivery_model comes only from the exports, which predate these stores. By account group, the WinTeam
-- service tier (dim_job.vertical) that means each model; a job with a delivery model already keeps it.
INSERT INTO ops.app_setting (key, value, description)
VALUES ('delivery_model_by_vertical',
        '{"Apple": {"Self-Service": "self_perform", "3rd Party Subcontractor": "subcontracted"}}'::jsonb,
        'By account group: dim_job.vertical -> delivery_model, for jobs with none. Applied at each jobs normalization.')
ON CONFLICT (key) DO NOTHING;
