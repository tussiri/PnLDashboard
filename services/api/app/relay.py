"""Relay (integration_mapper) connector: FedEx payables, AR, sites and work orders (migration 034).

Relay serves a read-only export (`GET /export/dashboard/{ap,ar,sites,work-orders,status}`, bearer
token; Relay docs/DASHBOARD_EXPORT.md). This module pulls every feed in full, page by page, and
replaces the matching core.relay_* snapshot in one transaction per feed, so a payable Relay removes
or a superseded invoice disappears here too. Each feed run is recorded in ops.integration_sync_run
(integration 'relay'). Nothing here writes to Relay.

Guard: a feed that comes back empty never wipes a snapshot that has rows. Relay answering with
nothing is far likelier to be a Relay problem than every FedEx payable vanishing, so the run is
recorded as failed and the previous snapshot stays.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from .config import settings
from .db import connection

logger = logging.getLogger(__name__)

INTEGRATION = "relay"
PAGE_SIZE = 2000
MAX_PAGES = 200


class RelayError(RuntimeError):
    pass


def configured() -> bool:
    return bool(settings.relay_base_url and settings.relay_export_token)


def _month(value: Any) -> date | None:
    """'2026-07' or '2026-07-01' -> first of the month."""
    text = str(value or "")[:7]
    try:
        return date(int(text[:4]), int(text[5:7]), 1) if len(text) == 7 and text[4] == "-" else None
    except ValueError:
        return None


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _ts(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _num(value: Any) -> float | None:
    try:
        return None if value is None else round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def ap_row(r: dict[str, Any]) -> tuple:
    return (int(r["id"]), _text(r.get("winteam_job_number")), _text(r.get("job_source")), _month(r.get("service_month")),
            _text(r.get("station")), _text(r.get("subtype")), _text(r.get("correlation_key")), _text(r.get("vendor_number")),
            _text(r.get("vendor_name")), _text(r.get("vendor_invoice_number")), _text(r.get("work_order_number")),
            bool(r.get("is_placeholder")), _num(r.get("amount")) or 0.0, _text(r.get("ar_invoice_number")), _text(r.get("status")),
            bool(r.get("in_winteam")), _text(r.get("winteam_ref")), _text(r.get("payment_status")), _num(r.get("paid_amount")),
            _date(r.get("paid_date")), _text(r.get("check_number")), bool(r.get("self_perform")), _ts(r.get("recorded_at")),
            _ts(r.get("pushed_at")), _ts(r.get("updated_at")), json.dumps(r))


def ar_row(r: dict[str, Any]) -> tuple:
    return (int(r["id"]), str(r["invoice_number"]), _text(r.get("customer_number")), _text(r.get("winteam_job_number")),
            _text(r.get("site_name")), _month(r.get("service_month")), _date(r.get("invoice_date")),
            _num(r.get("revenue_before_tax")) or 0.0, _num(r.get("tax")), _text(r.get("portal_state")),
            _num(r.get("remitted_amount")), _date(r.get("paid_date")), _ts(r.get("updated_at")), json.dumps(r))


def site_row(r: dict[str, Any]) -> tuple:
    return (int(r["id"]), _text(r.get("station")), _text(r.get("sc_location_id")), str(r["winteam_job_number"]),
            _text(r.get("service_kind")), _text(r.get("site_name")), bool(r.get("self_perform")), _text(r.get("subcontractor")),
            _num(r.get("ar_monthly")), _num(r.get("ap_monthly")), _text(r.get("billing_portal")), bool(r.get("has_contract")),
            _ts(r.get("updated_at")), json.dumps(r))


def work_order_row(r: dict[str, Any]) -> tuple:
    return (int(r["id"]), _text(r.get("correlation_key")), _text(r.get("station")), _text(r.get("subtype")),
            _month(r.get("service_month")), _text(r.get("winteam_job_number")), _text(r.get("work_order_number")),
            _text(r.get("status")), _num(r.get("ap_not_to_exceed")), _num(r.get("customer_not_to_exceed")),
            _ts(r.get("updated_at")), json.dumps(r))


FEEDS: dict[str, tuple[str, str, Callable[[dict[str, Any]], tuple]]] = {
    # feed -> (Relay path, core table with column list, row builder)
    "ap": ("/export/dashboard/ap",
           "core.relay_ap_payable (relay_id, winteam_job_number, job_source, service_month, station, subtype, correlation_key, "
           "vendor_number, vendor_name, vendor_invoice_number, work_order_number, is_placeholder, amount, ar_invoice_number, "
           "status, in_winteam, winteam_ref, payment_status, paid_amount, paid_date, check_number, self_perform, recorded_at, "
           "pushed_at, relay_updated_at, payload)", ap_row),
    "ar": ("/export/dashboard/ar",
           "core.relay_ar_invoice (relay_id, invoice_number, customer_number, winteam_job_number, site_name, service_month, "
           "invoice_date, revenue_before_tax, tax, portal_state, remitted_amount, paid_date, relay_updated_at, payload)", ar_row),
    "sites": ("/export/dashboard/sites",
              "core.relay_site (relay_id, station, sc_location_id, winteam_job_number, service_kind, site_name, self_perform, "
              "subcontractor, ar_monthly, ap_monthly, billing_portal, has_contract, relay_updated_at, payload)", site_row),
    "work_orders": ("/export/dashboard/work-orders",
                    "core.relay_work_order (relay_id, correlation_key, station, subtype, service_month, winteam_job_number, "
                    "work_order_number, status, ap_not_to_exceed, customer_not_to_exceed, relay_updated_at, payload)", work_order_row),
}


def _client() -> httpx.Client:
    return httpx.Client(base_url=settings.relay_base_url, timeout=settings.relay_timeout_seconds,
                        headers={"Authorization": f"Bearer {settings.relay_export_token}", "Accept": "application/json"},
                        follow_redirects=False)


def fetch_feed(client: httpx.Client, path: str) -> list[dict[str, Any]]:
    """Every row of one feed, following `page` until a short page."""
    rows: list[dict[str, Any]] = []
    for page in range(1, MAX_PAGES + 1):
        response = client.get(path, params={"page": page, "limit": PAGE_SIZE})
        if response.status_code in (401, 403):
            raise RelayError(f"Relay refused the export token (HTTP {response.status_code})")
        if response.status_code == 503:
            raise RelayError("Relay's dashboard export is not configured (DASHBOARD_EXPORT_TOKENS unset)")
        if response.status_code >= 400:
            raise RelayError(f"Relay answered HTTP {response.status_code} on {path}")
        body = response.json()
        data = body.get("data")
        if not isinstance(data, list):
            raise RelayError(f"Unexpected Relay response on {path}: no data list")
        rows.extend(data)
        if len(data) < int(body.get("limit") or PAGE_SIZE) or len(rows) >= int(body.get("total") or 0):
            return rows
    raise RelayError(f"{path}: more than {MAX_PAGES} pages")


def _record(run_id: str, feed: str, status: str, started: datetime, fetched: int, loaded: int, error: str | None) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ops.integration_sync_run (id, integration_name, resource_name, status, started_at, completed_at,
                                                  records_fetched, records_inserted, error_message)
            VALUES (%s, %s, %s, %s, %s, now(), %s, %s, %s)
            """,
            (run_id, INTEGRATION, feed, status, started, fetched, loaded, error),
        )
        conn.commit()


def replace_snapshot(feed: str, rows: list[dict[str, Any]]) -> int:
    """Swap one feed's snapshot in a single transaction; refuses to empty a table that has rows."""
    _path, target, builder = FEEDS[feed]
    table = target.split(" ", 1)[0]
    tuples = [builder(r) for r in rows]
    with connection() as conn, conn.cursor() as cursor:
        if not tuples:
            cursor.execute(f"SELECT EXISTS (SELECT 1 FROM {table}) AS has_rows")
            if cursor.fetchone()["has_rows"]:
                raise RelayError(f"Relay returned no {feed} rows; kept the previous snapshot")
        cursor.execute(f"DELETE FROM {table}")
        if tuples:
            placeholders = ", ".join(["%s"] * len(tuples[0]))
            cursor.executemany(f"INSERT INTO {target} VALUES ({placeholders})", tuples)
        conn.commit()
    return len(tuples)


def sync(feeds: list[str] | None = None) -> dict[str, Any]:
    """Pull and replace each feed; one feed failing does not stop the others. GET only."""
    if not configured():
        raise RelayError("Relay is not configured (RELAY_BASE_URL and RELAY_EXPORT_TOKEN)")
    results = []
    with _client() as client:
        for feed in feeds or list(FEEDS):
            started = datetime.now(timezone.utc)
            run_id = str(uuid.uuid4())
            fetched = loaded = 0
            try:
                rows = fetch_feed(client, FEEDS[feed][0])
                fetched = len(rows)
                loaded = replace_snapshot(feed, rows)
                _record(run_id, feed, "succeeded", started, fetched, loaded, None)
                results.append({"feed": feed, "status": "succeeded", "fetched": fetched, "loaded": loaded})
            except (RelayError, httpx.HTTPError, ValueError, KeyError) as exc:
                message = str(exc)[:500] or exc.__class__.__name__
                logger.warning("Relay %s sync failed: %s", feed, message)
                _record(run_id, feed, "failed", started, fetched, 0, message)
                results.append({"feed": feed, "status": "failed", "fetched": fetched, "loaded": 0, "error": message})
    return {"runs": results, "failed": [r["feed"] for r in results if r["status"] == "failed"]}


def status() -> dict[str, Any]:
    """Whether Relay is wired, the last run per feed and the snapshot sizes. Never returns the token."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT DISTINCT ON (resource_name) resource_name, status, completed_at, records_inserted, error_message
            FROM ops.integration_sync_run WHERE integration_name = %s ORDER BY resource_name, started_at DESC
            """,
            (INTEGRATION,),
        )
        runs = {r["resource_name"]: r for r in cursor.fetchall()}
        cursor.execute(
            """
            SELECT (SELECT count(*) FROM core.relay_ap_payable) AS ap, (SELECT count(*) FROM core.relay_ar_invoice) AS ar,
                   (SELECT count(*) FROM core.relay_site) AS sites, (SELECT count(*) FROM core.relay_work_order) AS work_orders
            """
        )
        counts = cursor.fetchone()
    return {
        "configured": configured(),
        "base_url_host": urlparse(settings.relay_base_url).hostname if settings.relay_base_url else None,
        "feeds": [{"feed": f, "rows": counts[f], **({k: runs[f][k] for k in ("status", "completed_at", "error_message")} if f in runs else {})}
                  for f in FEEDS],
    }
