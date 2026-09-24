-- 032: the nightly sync schedule (app/nightly.py, approved 2026-09-23).
-- Once a day at 02:30 America/Chicago: load the import inbox, sync WinTeam (primary and Sarus)
-- incrementally, rebuild the marts once. Edit the setting from the Administration page.
INSERT INTO ops.app_setting (key, value, description)
VALUES ('nightly_sync',
        '{"enabled": true, "hour": 2, "minute": 30, "timezone": "America/Chicago", "window_hours": 3, "import_inbox": true, "winteam": true, "sarus": true}'::jsonb,
        'Nightly sync: time (hour, minute, timezone; runs only within window_hours after it) and steps (import_inbox, winteam, sarus). The marts are rebuilt once at the end. enabled=false stops the schedule; on-demand syncs still work.')
ON CONFLICT (key) DO NOTHING;
