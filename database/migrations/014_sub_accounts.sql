-- 014: Sub-accounts on the weekly executive mart (docs/executive-pl.md, section 8).
--
-- The second level under a key account: for School districts the district ("Plano Independent
-- School District"), for FedEx the operating company by job-name prefix ("FedEx Express (FXE)",
-- "FedEx Ground (FXG)", else "FedEx"), for every other account the AR customer name when it
-- differs from the account (else the account itself). Derived by app.weekly.sub_account_for from
-- the setting sub_account_rules at the end of every mart.job_week rebuild; the rules are editable
-- through the admin settings API. /executive/labor-pl filters on it (sub_account=) and on
-- delivery_model (delivery=all|self_perform|subcontracted).
ALTER TABLE mart.job_week ADD COLUMN IF NOT EXISTS sub_account text;
CREATE INDEX IF NOT EXISTS job_week_sub_account_idx ON mart.job_week (parent_account, sub_account, week_start);

INSERT INTO ops.app_setting (key, value, description) VALUES
  ('sub_account_rules',
   '{"Education": {"basis": "customer_name",
                   "prefix_map": {"ws-": "White Settlement Independent School District",
                                  "white settlement": "White Settlement Independent School District",
                                  "plano": "Plano Independent School District",
                                  "henderson": "Henderson Independent School District",
                                  "crowley": "Crowley Independent School District",
                                  "crawley": "Crowley Independent School District",
                                  "aldine": "Aldine Independent School District"}},
     "FedEx": {"basis": "job_prefix",
               "prefix_map": {"fxe": "FedEx Express (FXE)", "fxg": "FedEx Ground (FXG)"},
               "default": "FedEx"},
     "*": {"basis": "customer_name"}}'::jsonb,
   'Executive labor P&L sub-account rules, keyed by parent account ("*" = every other account). For a job: if a prefix_map key matches the lowercased job name as a leading word (basis job_prefix: leading only; basis customer_name: leading or an inner word such as "plano - "), its label is the sub-account; else, with basis customer_name, the job''s AR customer name when present and different from the account; else "default" when set, else the account name. Applied by the mart rebuild (mart.job_week.sub_account).')
ON CONFLICT (key) DO NOTHING;
