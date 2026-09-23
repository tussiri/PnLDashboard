-- 027: records WinTeam cannot serve, remembered so an on-demand sync does not ask for them again.
--
-- The AP detail pull asks for each invoice by number. About a thousand Crane invoice numbers answer
-- 404 (a slash in the number, or a number reused by several vendors) and a few answer 500 every
-- time (Sarus "6.12.26", "Pay Adv 9.19.25"). Before this table each sync asked for all of them
-- again, and retried every 500 four times. winteam.py now leaves a failed record alone for
-- UNRETRIEVABLE_RECHECK (7 days), then asks once more in case the number was corrected, and
-- deletes the row as soon as the record is served.
CREATE TABLE IF NOT EXISTS ops.winteam_unretrievable (
  integration_name text NOT NULL,
  resource_name text NOT NULL,
  record_key text NOT NULL,
  status_code integer,
  attempts integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_name, resource_name, record_key)
);

COMMENT ON TABLE ops.winteam_unretrievable IS
  'WinTeam records that answered 404 or 5xx when asked for individually (AP invoice details); skipped until last_attempt_at is 7 days old.';
