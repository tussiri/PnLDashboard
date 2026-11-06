-- 066: a site with its own punches is self-performed (app/delivery.py).
--
-- dim_job.delivery_model came only from the export's is_self_perform flag, which marks LGB3, MCC1, PSP3, APC2,
-- IAG1 and BDL3/7 (Sarus) subcontracted although Crane punches thousands of hours there every month. Every mart
-- rebuild now marks a current job with at least min_hours punched in the last `weeks` weeks self-performed. A job
-- with no punches keeps its label. weeks 0 turns the rule off.
INSERT INTO ops.app_setting (key, value, description)
VALUES ('delivery_from_hours', '{"weeks": 8, "min_hours": 40}'::jsonb,
        'A current job with at least min_hours punched in the last `weeks` weeks is self-performed. Applied at each mart rebuild. weeks 0 = off.')
ON CONFLICT (key) DO NOTHING;
