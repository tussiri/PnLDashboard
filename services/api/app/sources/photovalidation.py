"""PhotoValidation connector: staffing request lines (Contract B) into core.fact_staffing_request.

PhotoValidation serves `GET {PHOTOVALIDATION_API_URL}/api/v1/staffing-requests?updatedSince=&page=&limit=`
with a bearer API token (PHOTOVALIDATION_API_TOKEN); the envelope is `{page, limit, count, data}` with
one row per request line, ordered by updatedAt ascending, then lineId. The updatedSince filter is
inclusive, so every row is upserted by line_id and a row seen twice is harmless.

Incremental pull: the cursor starts at the largest updated_at already held (nothing on the first
pull = the whole feed). After each full page the cursor moves to that page's last updatedAt and the
page number returns to 1, so a line edited while the pull is paging cannot shift an unseen row past
a page boundary; when a whole page shares the cursor's timestamp the page number advances instead.
A short page ends the pull. GET only; nothing is written to PhotoValidation.

After the upsert every line is re-resolved to core.dim_job and mart.job_week's requested / pending
headcount is refreshed (app/staffing.py). Each pull is recorded in ops.integration_sync_run
(integration 'photovalidation', resource 'staffing_requests'). Without PHOTOVALIDATION_API_URL and
PHOTOVALIDATION_API_TOKEN nothing runs.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlparse

import httpx
import psycopg

from .. import staffing
from ..config import settings
from ..db import connection

logger = logging.getLogger(__name__)

INTEGRATION = "photovalidation"
RESOURCE = "staffing_requests"
PATH = "/api/v1/staffing-requests"
PAGE_SIZE = 500
MAX_REQUESTS = 400
COMPANIES = ("Crane", "Sarus")

COLUMNS = (
    "line_id", "request_id", "request_code", "location_id", "site_name", "account_name", "winteam_job_number",
    "winteam_company", "role", "shift", "shift_start", "shift_end", "headcount_needed", "current_filled", "reason",
    "employment_type", "hours_per_week", "pay_rate", "needed_by", "status", "hire_job_id", "reported_headcount",
    "submitted_at", "decided_at", "posted_at", "filled_at", "closed_at", "updated_at", "payload",
)

UPSERT_SQL = f"""
INSERT INTO core.fact_staffing_request ({", ".join(COLUMNS)})
VALUES ({", ".join(["%s"] * len(COLUMNS))})
ON CONFLICT (line_id) DO UPDATE SET
  {", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c != "line_id")}, warehouse_loaded_at = now()
WHERE core.fact_staffing_request.updated_at <= EXCLUDED.updated_at
"""


class PhotoValidationError(RuntimeError):
    pass


def configured() -> bool:
    return settings.photovalidation_configured


# ── field parsing ────────────────────────────────────────────────────────────
def _text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _int(value: Any) -> int | None:
    try:
        return None if value is None or value == "" else int(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return None


def _num(value: Any) -> float | None:
    try:
        return None if value is None or value == "" else round(float(value), 2)
    except (TypeError, ValueError):
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


EPOCH = datetime.min.replace(tzinfo=timezone.utc)


def _updated(row: dict[str, Any]) -> datetime:
    return _ts(row.get("updatedAt")) or EPOCH


def request_row(r: dict[str, Any]) -> tuple:
    """One feed row as a tuple in COLUMNS order. Raises ValueError without lineId, requestId, status or a
    parseable updatedAt (such a row cannot be upserted or ordered)."""
    line_id, request_id, status, updated = _text(r.get("lineId")), _text(r.get("requestId")), _text(r.get("status")), _ts(r.get("updatedAt"))
    if not (line_id and request_id and status and updated):
        raise ValueError(f"row without lineId, requestId, status or updatedAt: {str(r.get('lineId'))[:40]}")
    company = _text(r.get("winteamCompany"))
    return (
        line_id, request_id, _text(r.get("requestCode")), _text(r.get("locationId")), _text(r.get("siteName")),
        _text(r.get("accountName")), _text(r.get("winteamJobNumber")), company if company in COMPANIES else None,
        _text(r.get("role")), _text(r.get("shift")), _text(r.get("shiftStart")), _text(r.get("shiftEnd")),
        _int(r.get("headcountNeeded")) or 0, _int(r.get("currentFilled")), _text(r.get("reason")),
        _text(r.get("employmentType")), _num(r.get("hoursPerWeek")), _num(r.get("payRate")), _date(r.get("neededBy")),
        status, _text(r.get("hireJobId")), _int(r.get("reportedHeadcount")),
        _ts(r.get("submittedAt")), _ts(r.get("decidedAt")), _ts(r.get("postedAt")), _ts(r.get("filledAt")),
        _ts(r.get("closedAt")), updated, json.dumps(r),
    )


# ── HTTP ─────────────────────────────────────────────────────────────────────
def _client() -> httpx.Client:
    return httpx.Client(base_url=settings.photovalidation_api_url, timeout=60,
                        headers={"Authorization": f"Bearer {settings.photovalidation_api_token}", "Accept": "application/json"},
                        follow_redirects=False)


def _page(client: httpx.Client, since: str | None, page: int, limit: int) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"page": page, "limit": limit}
    if since:
        params["updatedSince"] = since
    response = client.get(PATH, params=params)
    if response.status_code in (401, 403):
        raise PhotoValidationError(f"PhotoValidation refused the API token (HTTP {response.status_code})")
    if response.status_code >= 400:
        raise PhotoValidationError(f"PhotoValidation answered HTTP {response.status_code} on {PATH}")
    try:
        body = response.json()
    except ValueError as exc:
        raise PhotoValidationError(f"PhotoValidation answered non-JSON on {PATH}") from exc
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list):
        raise PhotoValidationError(f"Unexpected PhotoValidation response on {PATH}: no data list")
    return [row for row in data if isinstance(row, dict)]


def fetch_since(client: httpx.Client, since: str | None, limit: int = PAGE_SIZE, max_requests: int = MAX_REQUESTS) -> list[dict[str, Any]]:
    """Every row updated at or after `since` (all rows when None), one per lineId (the latest updatedAt wins)."""
    rows: dict[str, dict[str, Any]] = {}
    cursor, page = since, 1
    for _ in range(max_requests):
        data = _page(client, cursor, page, limit)
        for row in data:
            key = str(row.get("lineId") or "")
            if key not in rows or _updated(row) >= _updated(rows[key]):
                rows[key] = row
        if len(data) < limit:
            return list(rows.values())
        last = data[-1].get("updatedAt")
        if last and (cursor is None or _ts(last) != _ts(cursor)):
            cursor, page = str(last), 1
        else:
            page += 1
    raise PhotoValidationError(f"{PATH}: more than {max_requests} requests in one pull")


# ── database ─────────────────────────────────────────────────────────────────
def watermark(cursor: Any) -> str | None:
    """The largest updated_at held, as the ISO string to pass back as updatedSince."""
    cursor.execute("SELECT max(updated_at) AS at FROM core.fact_staffing_request")
    row = cursor.fetchone()
    at = row["at"] if row else None
    return at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if at else None


def shape(rows: list[dict[str, Any]]) -> tuple[list[tuple], list[str]]:
    """(tuples to upsert, errors for rows that cannot be stored)."""
    tuples: list[tuple] = []
    errors: list[str] = []
    for r in rows:
        try:
            tuples.append(request_row(r))
        except ValueError as exc:
            errors.append(str(exc))
    return tuples, errors


def upsert(conn: Any, tuples: list[tuple]) -> dict[str, int]:
    """Upsert the lines, re-resolve jobs and refresh the weekly demand in one transaction."""
    with conn.cursor() as cursor:
        if tuples:
            cursor.executemany(UPSERT_SQL, tuples)
        refreshed = staffing.refresh(cursor)
    conn.commit()
    return {"loaded": len(tuples), **refreshed}


def _record(run_id: str, status: str, started: datetime, fetched: int, loaded: int, error: str | None) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ops.integration_sync_run (id, integration_name, resource_name, status, started_at, completed_at,
                                                  records_fetched, records_inserted, error_message)
            VALUES (%s, %s, %s, %s, %s, now(), %s, %s, %s)
            """,
            (run_id, INTEGRATION, RESOURCE, status, started, fetched, loaded, error),
        )
        conn.commit()


def sync() -> dict[str, Any]:
    """One incremental pull. Raises PhotoValidationError when not configured; a failed pull is recorded
    and returned as status 'failed'."""
    if not configured():
        raise PhotoValidationError("PhotoValidation is not configured (PHOTOVALIDATION_API_URL and PHOTOVALIDATION_API_TOKEN)")
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    since: str | None = None
    fetched = 0
    try:
        with connection() as conn:
            with conn.cursor() as cursor:
                since = watermark(cursor)
            conn.commit()  # no transaction may span the HTTP pull
            with _client() as client:
                rows = fetch_since(client, since)
            fetched = len(rows)
            tuples, errors = shape(rows)
            result = upsert(conn, tuples)
    except (PhotoValidationError, httpx.HTTPError, psycopg.Error) as exc:
        message = str(exc)[:500] or exc.__class__.__name__
        logger.warning("PhotoValidation pull failed: %s", message)
        _record(run_id, "failed", started, fetched, 0, message)
        return {"run_id": run_id, "status": "failed", "since": since, "fetched": fetched, "loaded": 0, "rejected": 0, "error": message}
    error = f"{len(errors)} row(s) rejected: {'; '.join(errors[:5])}" if errors else None
    _record(run_id, "succeeded", started, fetched, result["loaded"], error)
    logger.info("PhotoValidation pull: since=%s fetched=%s loaded=%s rejected=%s job_week_rows=%s",
                since, fetched, result["loaded"], len(errors), result["job_week_rows_changed"])
    return {"run_id": run_id, "status": "succeeded", "since": since, "fetched": fetched, "rejected": len(errors), **result}


def status() -> dict[str, Any]:
    """Whether the feed is wired, its last pull, the watermark and line counts. Never returns the token."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT status, started_at, completed_at, records_fetched, records_inserted, error_message
            FROM ops.integration_sync_run WHERE integration_name = %s ORDER BY started_at DESC LIMIT 1
            """,
            (INTEGRATION,),
        )
        last = cursor.fetchone()
        cursor.execute(
            """
            SELECT count(*) AS lines, count(*) FILTER (WHERE job_key IS NOT NULL) AS mapped,
                   count(*) FILTER (WHERE status IN ('submitted', 'approved', 'posted')) AS open
            FROM core.fact_staffing_request
            """
        )
        counts = cursor.fetchone()
        mark = watermark(cursor)
    return {
        "configured": configured(),
        "base_url_host": urlparse(settings.photovalidation_api_url).hostname if settings.photovalidation_api_url else None,
        "interval_minutes": settings.pv_sync_interval_minutes or None,
        "watermark": mark,
        "lines": counts["lines"], "mapped_lines": counts["mapped"], "open_lines": counts["open"],
        "last_run": {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in dict(last).items()} if last else None,
    }
