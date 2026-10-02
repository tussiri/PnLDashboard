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

Admin > Imports shows the inbox: the last check, **Check inbox now**, and every attachment it has
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

`ops.app_setting` key `mail_inbox`: `{"enabled": true, "every_minutes": 30, "first_lookback_days": 14}`.
The first check reads the last 14 days. Set `enabled` to false to stop automatic checks (Check inbox
now still works); the nightly run reads the mailbox once too (`nightly_sync.mail_inbox`).

## Routes

| Route | |
|---|---|
| `GET /api/v1/integrations/mail` | configured, mailbox, schedule, last check, the 50 most recent attachments with their status |
| `POST /api/v1/integrations/mail/poll` | admin: check now; rebuilds the marts when a report loaded |
