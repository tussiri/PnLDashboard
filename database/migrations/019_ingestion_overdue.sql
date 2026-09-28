-- 019: Expose the last run's error on the ingestion freshness view.
--
-- The worker can stop producing rows without ever recording a failure: on 2026-09-10 a
-- self-deadlocked sync (two connections, one holding core.* row locks while idle in transaction)
-- left every resource reporting `last_status = succeeded` while nothing was pulled for nine days.
-- /api/v1/data/freshness now derives an `overdue` flag from seconds_since_last_completion, and it
-- needs the error text to tell a resource that is genuinely behind from one the tenant is not
-- entitled to (HTTP 403 on job_schedules and ap_payments), which never completes by design.
--
-- View-only change; the underlying columns already exist on ops.integration_sync_run. last_error is
-- appended at the END of the column list because CREATE OR REPLACE VIEW can only add trailing
-- columns - inserting one mid-list fails with "cannot change name of view column".
CREATE OR REPLACE VIEW mart.v_winteam_ingestion_freshness AS
SELECT configured.resource_name,
    latest.status AS last_status,
    latest.started_at AS last_started_at,
    latest.completed_at AS last_completed_at,
    latest.records_fetched,
    latest.records_inserted,
    watermark.watermark_value,
    watermark.updated_at AS watermark_updated_at,
    EXTRACT(epoch FROM now() - latest.completed_at)::bigint AS seconds_since_last_completion,
    latest.error_message AS last_error
   FROM ( SELECT DISTINCT integration_sync_run.resource_name
           FROM ops.integration_sync_run) configured
     LEFT JOIN LATERAL ( SELECT r.status,
            r.started_at,
            r.completed_at,
            r.records_fetched,
            r.records_inserted,
            r.error_message
           FROM ops.integration_sync_run r
          WHERE r.integration_name = 'winteam'::text AND r.resource_name = configured.resource_name
          ORDER BY r.started_at DESC
         LIMIT 1) latest ON true
     LEFT JOIN ops.source_watermark watermark ON watermark.integration_name = 'winteam'::text AND watermark.resource_name = configured.resource_name;
