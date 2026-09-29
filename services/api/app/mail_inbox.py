"""The records mailbox poller: dashboard report exports that arrive by email (migration 038).

Reads GRAPH_MAILBOX (records@smcraneifs.com) through Microsoft Graph with an app registration
(client credentials, application permission Mail.Read, limited to that mailbox by an Exchange
application access policy; docs/mail-inbox.md). Read-only: nothing is moved, flagged, deleted or sent.

Each poll lists inbox messages with attachments received since the last one handled (a day of
overlap; ops.mail_attachment remembers every attachment, so each is handled once). CSV and Excel
attachments are downloaded and loaded only when their columns match a dashboard feed (the Pay
Report or timekeeping labor summary, the Job Cost Analysis, the Trend Income Statement) through the
same importer as uploads (origin 'mail'). Everything else in the mailbox is recorded as 'ignored' and
never loaded. When anything loaded, the marts are rebuilt once. Each poll is a run of integration
'mail_inbox' in ops.integration_sync_run.

Schedule: ops.app_setting 'mail_inbox' = {"enabled", "every_minutes", "first_lookback_days"}; the
worker checks once a minute and polls when every_minutes have passed since the last poll.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator
from urllib.parse import quote

import httpx

from .config import settings
from .db import connection

logger = logging.getLogger(__name__)

INTEGRATION = "mail_inbox"
GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"
SPREADSHEETS = (".csv", ".xlsx", ".xlsm")
MAX_BYTES = 50 * 1024 * 1024
OVERLAP = timedelta(days=1)
DEFAULT_SETTING: dict[str, Any] = {"enabled": True, "every_minutes": 30, "first_lookback_days": 14}


class MailError(RuntimeError):
    pass


def configured() -> bool:
    return bool(settings.graph_tenant_id and settings.graph_client_id and settings.graph_client_secret and settings.graph_mailbox)


def setting(cursor: Any) -> dict[str, Any]:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'mail_inbox'")
    row = cursor.fetchone()
    value = row["value"] if row and isinstance(row["value"], dict) else {}
    return {**DEFAULT_SETTING, **value}


class Graph:
    """A small Microsoft Graph client for one mailbox (GETs, plus the token request)."""

    def __init__(self, client: httpx.Client | None = None):
        self.client = client or httpx.Client(timeout=settings.graph_timeout_seconds, follow_redirects=True)
        self.token: str | None = None
        self.expires = 0.0
        self.mailbox = quote(settings.graph_mailbox)

    def _token(self) -> str:
        if self.token and time.monotonic() < self.expires - 60:
            return self.token
        response = self.client.post(f"{LOGIN}/{settings.graph_tenant_id}/oauth2/v2.0/token", data={
            "client_id": settings.graph_client_id, "client_secret": settings.graph_client_secret,
            "scope": "https://graph.microsoft.com/.default", "grant_type": "client_credentials"})
        if response.status_code != 200:
            raise MailError(f"Microsoft sign-in refused the app registration (HTTP {response.status_code})")
        body = response.json()
        self.token, self.expires = body["access_token"], time.monotonic() + float(body.get("expires_in", 3600))
        return self.token

    def get(self, url: str, params: dict[str, str] | None = None) -> httpx.Response:
        response = self.client.get(url if url.startswith("http") else f"{GRAPH}{url}", params=params,
                                   headers={"Authorization": f"Bearer {self._token()}"})
        if response.status_code in (401, 403):
            raise MailError(f"Microsoft Graph refused access to {settings.graph_mailbox} (HTTP {response.status_code}); "
                            "check the Mail.Read permission, admin consent and the mailbox access policy")
        if response.status_code >= 400:
            raise MailError(f"Microsoft Graph answered HTTP {response.status_code}")
        return response

    def messages(self, since: datetime) -> Iterator[dict[str, Any]]:
        """Inbox messages with attachments received since `since`, oldest first (all pages)."""
        url: str | None = f"/users/{self.mailbox}/mailFolders/inbox/messages"
        params: dict[str, str] | None = {
            "$filter": f"receivedDateTime ge {since.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} and hasAttachments eq true",
            "$orderby": "receivedDateTime asc", "$select": "id,subject,from,receivedDateTime", "$top": "50"}
        while url:
            body = self.get(url, params).json()
            yield from body.get("value", [])
            url, params = body.get("@odata.nextLink"), None

    def attachments(self, message_id: str) -> list[dict[str, Any]]:
        body = self.get(f"/users/{self.mailbox}/messages/{quote(message_id)}/attachments", {"$select": "id,name,size,contentType"}).json()
        return [a for a in body.get("value", []) if a.get("@odata.type", "#microsoft.graph.fileAttachment") == "#microsoft.graph.fileAttachment"]

    def download(self, message_id: str, attachment_id: str) -> bytes:
        return self.get(f"/users/{self.mailbox}/messages/{quote(message_id)}/attachments/{quote(attachment_id)}/$value").content


def recognize(file_name: str, content: bytes) -> str | None:
    """The dashboard feed an attachment is, from its columns (or a feed file name), else None."""
    from . import imports, native_exports

    try:
        headers, _rows = imports.read_table(file_name, content)
    except Exception:  # noqa: BLE001 - an unreadable spreadsheet is simply not a dashboard report
        return None
    layout = native_exports.native_layout(headers)
    return native_exports.LAYOUT_KIND[layout] if layout else imports.detect_kind(file_name, headers)


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _seen(cursor: Any, message_id: str, attachment_id: str) -> bool:
    cursor.execute("SELECT 1 FROM ops.mail_attachment WHERE message_id = %s AND attachment_id = %s", (message_id, attachment_id))
    return cursor.fetchone() is not None


def _remember(cursor: Any, message: dict[str, Any], attachment: dict[str, Any], status: str, reason: str | None, file_id: int | None) -> None:
    sender = ((message.get("from") or {}).get("emailAddress") or {}).get("address")
    cursor.execute(
        """
        INSERT INTO ops.mail_attachment (message_id, attachment_id, received_at, sender, subject, file_name, size_bytes, status, reason, import_file_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING
        """,
        (message["id"], attachment["id"], _parse_time(message["receivedDateTime"]), sender, (message.get("subject") or "")[:500],
         attachment.get("name") or "attachment", attachment.get("size"), status, reason, file_id),
    )


def poll(graph: Graph | None = None, rebuild: bool = True) -> dict[str, Any]:
    """Read the mailbox once. Returns counts per status and whether the marts were rebuilt."""
    from . import imports, marts

    if not configured():
        raise MailError("The records mailbox is not configured (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_MAILBOX)")
    graph = graph or Graph()
    counts = {"loaded": 0, "duplicate": 0, "failed": 0, "ignored": 0, "messages": 0}
    with connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT max(received_at) AS last FROM ops.mail_attachment")
            last = cursor.fetchone()["last"]
            since = last - OVERLAP if last else datetime.now(timezone.utc) - timedelta(days=int(setting(cursor)["first_lookback_days"]))
        for message in graph.messages(since):
            counts["messages"] += 1
            for attachment in graph.attachments(message["id"]):
                with conn.cursor() as cursor:
                    if _seen(cursor, message["id"], attachment["id"]):
                        continue
                name = attachment.get("name") or "attachment"
                status, reason, file_id = "ignored", None, None
                if not name.lower().endswith(SPREADSHEETS):
                    reason = "not a CSV or Excel file"
                elif (attachment.get("size") or 0) > MAX_BYTES:
                    reason = "larger than 50 MB"
                else:
                    content = graph.download(message["id"], attachment["id"])
                    kind = recognize(name, content)
                    if kind is None:
                        reason = "not a dashboard report"
                    else:
                        result = imports.load_file(conn, name, content, kind=kind, origin="mail",
                                                   uploaded_by=f"mail:{((message.get('from') or {}).get('emailAddress') or {}).get('address') or 'unknown'}")
                        status, file_id = result["status"], result["import_file_id"]
                        reason = "; ".join(result.get("errors") or [])[:500] or None
                counts[status] += 1
                with conn.cursor() as cursor:
                    _remember(cursor, message, attachment, status, reason, file_id)
                conn.commit()
    rebuilt = bool(rebuild and counts["loaded"])
    if rebuilt:
        marts.rebuild_all(initiated_by="mail-inbox")
    return {**counts, "rebuilt": rebuilt}


def _record(run_id: str, status: str, started: datetime, loaded: int, fetched: int, error: str | None) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ops.integration_sync_run (id, integration_name, resource_name, status, started_at, completed_at,
                                                  records_fetched, records_inserted, error_message)
            VALUES (%s, %s, 'inbox', %s, %s, now(), %s, %s, %s)
            """,
            (run_id, INTEGRATION, status, started, fetched, loaded, error),
        )
        conn.commit()


def run(rebuild: bool = True) -> dict[str, Any]:
    """One recorded poll. Never raises: a failure is recorded on the run."""
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    try:
        result = poll(rebuild=rebuild)
    except Exception as exc:  # noqa: BLE001 - recorded, and the worker carries on
        message = str(exc)[:500] or exc.__class__.__name__
        logger.warning("Records mailbox poll failed: %s", message)
        _record(run_id, "failed", started, 0, 0, message)
        return {"status": "failed", "error": message}
    _record(run_id, "succeeded", started, result["loaded"], result["loaded"] + result["duplicate"] + result["failed"] + result["ignored"], None)
    return {"status": "succeeded", **result}


def check_and_poll(now: datetime | None = None) -> dict[str, Any] | None:
    """Poll when configured, enabled and every_minutes have passed since the last poll."""
    if not configured():
        return None
    with connection() as conn, conn.cursor() as cursor:
        cfg = setting(cursor)
        if not cfg.get("enabled"):
            return None
        cursor.execute("SELECT max(started_at) AS at FROM ops.integration_sync_run WHERE integration_name = %s", (INTEGRATION,))
        last = cursor.fetchone()["at"]
    now = now or datetime.now(timezone.utc)
    if last and now - last < timedelta(minutes=float(cfg.get("every_minutes", 30))):
        return None
    return run()


def status(limit: int = 50) -> dict[str, Any]:
    """Whether the mailbox is wired, its schedule, the last poll and the most recent attachments. No secrets."""
    with connection() as conn, conn.cursor() as cursor:
        cfg = setting(cursor)
        cursor.execute(
            """
            SELECT status, started_at, completed_at, records_inserted, error_message FROM ops.integration_sync_run
            WHERE integration_name = %s ORDER BY started_at DESC LIMIT 1
            """,
            (INTEGRATION,),
        )
        last = cursor.fetchone()
        cursor.execute(
            """
            SELECT m.received_at, m.sender, m.subject, m.file_name, m.status, m.reason, f.kind, f.rows_loaded
            FROM ops.mail_attachment m LEFT JOIN ops.import_file f ON f.import_file_id = m.import_file_id
            ORDER BY m.received_at DESC, m.file_name LIMIT %s
            """,
            (limit,),
        )
        recent = [dict(r) for r in cursor.fetchall()]
    return {"configured": configured(), "mailbox": settings.graph_mailbox or None, "schedule": cfg,
            "last_run": dict(last) if last else None, "recent": recent}
