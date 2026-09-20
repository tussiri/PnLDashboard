-- 013: Key accounts for the executive dashboard, and FedEx grouping that includes FXE/FXG station jobs.

-- FedEx rule: station jobs are named "FXE_<code> City ST" / "FXG_<num> ... City ST".
UPDATE ops.app_setting
SET value = (
  SELECT jsonb_agg(
    CASE WHEN g->>'name' = 'FedEx'
         THEN jsonb_set(jsonb_set(g, '{terms}', (
                SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text(coalesce(g->'terms','[]'::jsonb) || '["fxe","fxg"]'::jsonb) t)),
              '{customer_terms}', (
                SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text(coalesce(g->'customer_terms','[]'::jsonb) || '["fxe","fxg"]'::jsonb) t))
         ELSE g END
    ORDER BY ord)
  FROM jsonb_array_elements(value) WITH ORDINALITY AS x(g, ord)
), updated_at = now(), updated_by = 'migration 013'
WHERE key = 'account_groups' AND jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0;

INSERT INTO ops.app_setting (key, value, description) VALUES
  ('key_accounts',
   '[{"name":"FedEx","label":"FedEx (incl. FXE, FXG)"},{"name":"Amazon","label":"Amazon"},{"name":"Education","label":"School districts"},{"name":"Whole Foods","label":"Whole Foods"},{"name":"Aldi","label":"Aldi"}]'::jsonb,
   'Accounts offered on the executive dashboard, in order: [{name: account group name, label: display label}]. "All" on the executive dashboard means these accounts combined.')
ON CONFLICT (key) DO NOTHING;
