# Reports mailbox poller

The worker reads **reports@smcraneifs.com** through Microsoft Graph and loads the report exports
that belong to the dashboard (`app/mail_inbox.py`, migration 038). Everything else in the mailbox is
left alone.

## What it does

- Every 30 minutes (and once in the nightly run), it lists inbox messages with attachments received
  since the last one it handled, with a day of overlap.
- It opens only CSV and Excel attachments. A file is loaded when its columns match a dashboard feed
  (docs/export-feeds.md): the Pay Report or timekeeping labor summary, the Job Cost Analysis (either
  layout) or the Trend Income Statement. It goes through the same importer as an upload, so the
  import history, duplicate check and errors in Admin > Imports apply.
- Any other attachment (other reports, PDFs, images) is recorded as **ignored** with the reason and
  never loaded or downloaded more than once.
- Each attachment is handled once (`ops.mail_attachment`). When anything loaded, the marts are
  rebuilt.
- **Read-only.** It lists messages and downloads attachments; it never moves, flags, marks read,
  deletes or sends mail.

## Shared inbox: what is the dashboard's

reports@ also feeds other tools' ingestion pipelines. Two layers keep their mail out:

1. **The mail rules** (Admin > Mailbox, or `mail_inbox.rules`), checked before an attachment is
   downloaded. Mail matching **any** rule is the dashboard's; with no rules, every attachment goes on
   to the column check. Within a rule, each field that is filled in must match (several values in a
   field, comma-separated, are alternatives), and a rule needs a sender, a subject or a file name.

   | Field | Matches | Example |
   |---|---|---|
   | Senders | the sender's address, or any address at `@domain` | `reports-bot@smcraneifs.com` |
   | Subject contains | the subject contains one of them (case ignored) | `[Dashboard]` |
   | Ignore subjects containing | a subject containing any of them is ignored, whatever else matches | `Power BI` |
   | File names | the attachment name matches one glob (case ignored) | `*_timekeeping_recent_*.csv`, `SYS Query Scheduler*.xlsx` |

   The most reliable rule is a subject tag: put `[Dashboard]` in the subject of the WinTeam Query
   Scheduler jobs meant for the dashboard and set **Subject contains** to `[Dashboard]`. The sender
   alone rarely separates them, because both pipelines' reports come from the same scheduler.
   Use one rule per kind of mail, e.g. "Timekeeping" (sender @smcraneifs.com, files
   `*_timekeeping_recent_*.csv`) and "Job cost" (subject `[Dashboard]`, files `SYS Query Scheduler*.xlsx`).
   Refused mail is listed as ignored with the reason (one rule's reason, or "matches none of the N
   mail rules").
2. **The columns and the filtered-export guard**, always on. Only an attachment shaped like a
   dashboard feed is loaded, and a feed replaces data (a company's labor over the file's dates, a
   company's job cost for its months). So a mailed file that, for some company, carries under half of
   the jobs already loaded for the same dates or months (where at least 10 are loaded) is refused as
   a filtered export, typically another tool's report run for a few jobs. To load such a file on
   purpose, upload it on Admin > Imports, where the guard does not apply.

Admin > Mailbox shows the inbox: the last check, **Check inbox now**, and every attachment it has
seen with what it did. A failed check shows as "Reports inbox sync failed" in the dashboard notes.

## Setup (Microsoft Entra ID and Exchange Online)

1. **App registration.** Entra admin center > App registrations > New registration, for example
   "Crane IFS dashboard - reports inbox". Single tenant; no redirect URI.
2. **Permission.** API permissions > Add > Microsoft Graph > **Application permissions** > `Mail.Read`.
   Grant admin consent. (Application permission, because the poller runs without a signed-in user.)
3. **Client secret.** Certificates & secrets > New client secret. Copy the value once.
4. **Limit it to the one mailbox.** `Mail.Read` as an application permission reaches every mailbox
   until an application access policy scopes it. In Exchange Online PowerShell:

   ```powershell
   New-DistributionGroup -Name "Dashboard Mail Scope" -Type Security -Members reports@smcraneifs.com
   New-ApplicationAccessPolicy -AppId <Application (client) ID> -PolicyScopeGroupId "Dashboard Mail Scope" `
     -AccessRight RestrictAccess -Description "Crane IFS dashboard reads only reports@"
   Test-ApplicationAccessPolicy -Identity reports@smcraneifs.com -AppId <Application (client) ID>
   ```

   `Test-ApplicationAccessPolicy` should answer `Granted` for reports@ and `Denied` for any other
   mailbox. Microsoft's current guidance may prefer RBAC for Applications; either scoping works.
5. **Settings** (Render: `crane-ifs-api` > Environment; local: `.env`):

   | Variable | Value |
   |---|---|
   | `GRAPH_TENANT_ID` | Directory (tenant) ID |
   | `GRAPH_CLIENT_ID` | Application (client) ID |
   | `GRAPH_CLIENT_SECRET` | the client secret value |
   | `GRAPH_MAILBOX` | `reports@smcraneifs.com` |

   The secret stays server-side (API and worker only); nothing reaches the browser.

## Schedule

`ops.app_setting` key `mail_inbox`: `{"enabled": true, "every_minutes": 30, "first_lookback_days": 14, "rules": [{"name", "senders", "subjects", "exclude_subjects", "files"}]}`
(a setting saved with one `rule` object reads as one rule)
(`PUT /settings/mail_inbox`, validated: every_minutes 5 to 1440, first_lookback_days 1 to 90).
The first check reads the last 14 days. Set `enabled` to false to stop automatic checks (Check inbox
now still works); the nightly run reads the mailbox once too (`nightly_sync.mail_inbox`).

## Routes

| Route | |
|---|---|
| `GET /api/v1/integrations/mail` | configured, mailbox, schedule, last check, the 50 most recent attachments with their status |
| `POST /api/v1/integrations/mail/poll` | admin: check now; rebuilds the marts when a report loaded |
