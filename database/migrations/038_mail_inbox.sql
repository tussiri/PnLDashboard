-- 038: report exports read from the records mailbox through Microsoft Graph (app/mail_inbox.py).
--
-- The worker reads the inbox (read-only: nothing is moved, flagged or sent), opens CSV / XLSX
-- attachments and loads the ones whose columns match a dashboard feed through the same importer as
-- uploads (origin 'mail'). Every attachment it looked at is remembered here, loaded or ignored, so
-- a message is handled once; other reports in the mailbox are recorded as 'ignored' and never loaded.

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_origin_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_origin_check CHECK (origin IN ('upload', 'inbox', 'mail'));

CREATE TABLE IF NOT EXISTS ops.mail_attachment (
  message_id text NOT NULL,
  attachment_id text NOT NULL,
  received_at timestamptz NOT NULL,
  sender text,
  subject text,
  file_name text NOT NULL,
  size_bytes integer,
  status text NOT NULL CHECK (status IN ('loaded', 'duplicate', 'failed', 'ignored')),
  reason text,
  import_file_id bigint REFERENCES ops.import_file (import_file_id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS mail_attachment_received_idx ON ops.mail_attachment (received_at DESC);

INSERT INTO ops.app_setting (key, value, description)
VALUES ('mail_inbox', '{"enabled": true, "every_minutes": 30, "first_lookback_days": 14}',
        'Records mailbox poller (app/mail_inbox.py): how often the worker reads the inbox, and how far back the first read goes.')
ON CONFLICT (key) DO NOTHING;
