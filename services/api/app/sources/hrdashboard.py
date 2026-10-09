"""HrDashboard connector: site positions, headcount, hires and separations by week (migration 053).

HrDashboard serves a read-only machine API, `GET /api/service/v1/pnl/site-staffing?from&to` (bearer
token; HrDashboard docs/ARCHITECTURE.md "Service API"). One row per site per Monday-start week, keyed
by HR's WinTeam tenant ('primary', or a code such as 'SAR') and that tenant's own job number. The
tenant is mapped to the warehouse's WinTeam database ('Crane' | 'Sarus') by HR_TENANT_COMPANIES.

Each pull asks for the last LOOKBACK_WEEKS weeks and upserts them into core.hr_site_staffing_week.
Hires and separations are overwritten; the current-state figures (positions, filled, open, active
headcount) only ever replace a NULL or an older value with a value, never a value with a NULL, so
past weeks keep what HR said while they were current. Runs are recorded in ops.integration_sync_run
(integration 'hrdashboard'). Nothing here writes to HrDashboard.

Guard: an answer with no rows changes nothing; HR answering with no sites at all is far likelier to
be an HR problem than every site vanishing, so the run is recorded as failed.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import httpx

from ..config import settings
from ..db import connection

logger = logging.getLogger(__name__)

INTEGRATION = "hrdashboard"
RESOURCE = "site_staffing"
PATH = "/api/service/v1/pnl/site-staffing"
LOOKBACK_WEEKS = 8


class HrDashboardError(RuntimeError):
    pass


def configured() -> bool:
    return bool(settings.hr_base_url and settings.hr_export_token)


def tenant_companies(raw: str) -> dict[str, str]:
    """'primary:Crane,SAR:Sarus' -> {'primary': 'Crane', 'SAR': 'Sarus'}; blank or malformed pairs are skipped."""
    out: dict[str, str] = {}
    for pair in (raw or "").split(","):
        tenant, _, company = pair.partition(":")
        if tenant.strip() and company.strip():
            out[tenant.strip()] = company.strip()
    return out


def _int(value: Any) -> int | None:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None


def _num(value: Any) -> float | None:
    try:
        return None if value is None else round(float(value), 1)
    except (TypeError, ValueError):
        return None


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _choice(value: Any, allowed: tuple[str, ...]) -> str | None:
    return value if value in allowed else None


def staffing_row(r: dict[str, Any], companies: dict[str, str], as_of: date | None) -> tuple | None:
    """One upsert tuple, or None for a row whose tenant has no company mapping or whose keys are missing."""
    company = companies.get(str(r.get("tenant") or ""))
    job_number = str(r.get("jobNumber") or "").strip()
    week_start = _date(r.get("weekStart"))
    if not company or not job_number or week_start is None:
        return None
    return (company, job_number, week_start, _int(r.get("hires")), _int(r.get("separations")),
            _num(r.get("budgetedPositions")), _choice(r.get("positionsSource"), ("tracker", "budget", "observed")),
            _int(r.get("filledPositions")), _int(r.get("openPositions")), _int(r.get("activeHeadcount")),
            _choice(r.get("headcountSource"), ("employee_master", "timekeeping")), as_of)


UPSERT_SQL = """
INSERT INTO core.hr_site_staffing_week (winteam_company, winteam_job_number, week_start, hires, separations,
                                        budgeted_positions, positions_source, filled_positions, open_positions,
                                        active_headcount, headcount_source, hr_as_of)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (winteam_company, winteam_job_number, week_start) DO UPDATE SET
  hires = excluded.hires,
  separations = excluded.separations,
  budgeted_positions = coalesce(excluded.budgeted_positions, core.hr_site_staffing_week.budgeted_positions),
  positions_source = CASE WHEN excluded.budgeted_positions IS NOT NULL THEN excluded.positions_source
                          ELSE core.hr_site_staffing_week.positions_source END,
  filled_positions = coalesce(excluded.filled_positions, core.hr_site_staffing_week.filled_positions),
  open_positions = coalesce(excluded.open_positions, core.hr_site_staffing_week.open_positions),
  active_headcount = coalesce(excluded.active_headcount, core.hr_site_staffing_week.active_headcount),
  headcount_source = CASE WHEN excluded.active_headcount IS NOT NULL THEN excluded.headcount_source
                          ELSE core.hr_site_staffing_week.headcount_source END,
  hr_as_of = excluded.hr_as_of,
  loaded_at = now()
"""

# Same resolution as core.fact_staffing_request (app/staffing.py RESOLVE_JOB_KEYS_SQL).
RESOLVE_JOB_KEYS_SQL = """
WITH resolved AS (
  SELECT h.winteam_company, h.winteam_job_number,
         CASE h.winteam_company
           WHEN 'Crane' THEN coalesce(
             (SELECT a.job_key FROM mart.v_api_job_map a
               WHERE a.raw_job_number = h.winteam_job_number AND a.company IS DISTINCT FROM 'Sarus' LIMIT 1),
             (SELECT d.job_key FROM core.dim_job d
               WHERE d.valid_to IS NULL AND d.job_number = 'Crane:' || h.winteam_job_number LIMIT 1))
           WHEN 'Sarus' THEN
             (SELECT s.job_key FROM mart.v_sarus_job_map s WHERE s.raw_job_number = h.winteam_job_number LIMIT 1)
         END AS job_key
  FROM (SELECT DISTINCT winteam_company, winteam_job_number FROM core.hr_site_staffing_week) h
)
UPDATE core.hr_site_staffing_week w
SET job_key = x.job_key
FROM resolved x
WHERE w.winteam_company = x.winteam_company AND w.winteam_job_number = x.winteam_job_number
  AND w.job_key IS DISTINCT FROM x.job_key
"""


def _client() -> httpx.Client:
    return httpx.Client(base_url=settings.hr_base_url, timeout=settings.hr_timeout_seconds,
                        headers={"Authorization": f"Bearer {settings.hr_export_token}", "Accept": "application/json"},
                        follow_redirects=False)


def fetch(client: httpx.Client, today: date) -> dict[str, Any]:
    """HR's answer for the last LOOKBACK_WEEKS weeks through `today`."""
    params = {"from": (today - timedelta(weeks=LOOKBACK_WEEKS - 1)).isoformat(), "to": today.isoformat()}
    response = client.get(PATH, params=params)
    if response.status_code == 401:
        raise HrDashboardError("HrDashboard refused the export token (HTTP 401)")
    if response.status_code == 503:
        raise HrDashboardError("HrDashboard's service API is not configured (SERVICE_API_TOKEN_HASHES unset)")
    if response.status_code >= 400:
        raise HrDashboardError(f"HrDashboard answered HTTP {response.status_code} on {PATH}")
    body = response.json()
    if not isinstance(body.get("data"), list):
        raise HrDashboardError(f"Unexpected HrDashboard response on {PATH}: no data list")
    return body


def load(body: dict[str, Any], companies: dict[str, str]) -> dict[str, int]:
    """Upsert the rows and resolve job keys in one transaction; returns counts."""
    as_of = _date(body.get("asOf"))
    tuples = [t for t in (staffing_row(r, companies, as_of) for r in body["data"]) if t is not None]
    if not tuples:
        raise HrDashboardError("HrDashboard returned no site rows with a mapped tenant; nothing was changed")
    with connection() as conn, conn.cursor() as cursor:
        cursor.executemany(UPSERT_SQL, tuples)
        cursor.execute(RESOLVE_JOB_KEYS_SQL)
        conn.commit()
    return {"loaded": len(tuples), "skipped": len(body["data"]) - len(tuples)}


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
    """Pull and upsert the last LOOKBACK_WEEKS weeks. GET only against HrDashboard. Raises on failure
    after recording it."""
    if not configured():
        raise HrDashboardError("HrDashboard is not configured (HR_BASE_URL and HR_EXPORT_TOKEN)")
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    fetched = 0
    try:
        with _client() as client:
            body = fetch(client, started.date())
        fetched = len(body["data"])
        counts = load(body, tenant_companies(settings.hr_tenant_companies))
    except (HrDashboardError, httpx.HTTPError, ValueError) as exc:
        message = str(exc)[:500] or exc.__class__.__name__
        logger.warning("HrDashboard sync failed: %s", message)
        _record(run_id, "failed", started, fetched, 0, message)
        raise HrDashboardError(message) from exc
    _record(run_id, "succeeded", started, fetched, counts["loaded"], None)
    return {"status": "succeeded", "fetched": fetched, **counts}


def status() -> dict[str, Any]:
    """Whether HrDashboard is wired, the last run, and how much is held. Never returns the token."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT status, completed_at, records_inserted, error_message FROM ops.integration_sync_run
            WHERE integration_name = %s ORDER BY started_at DESC LIMIT 1
            """,
            (INTEGRATION,),
        )
        last = cursor.fetchone()
        cursor.execute(
            """
            SELECT count(*) AS rows, count(DISTINCT (winteam_company, winteam_job_number)) AS sites,
                   count(DISTINCT (winteam_company, winteam_job_number)) FILTER (WHERE job_key IS NULL) AS unmapped_sites,
                   max(week_start) AS latest_week
            FROM core.hr_site_staffing_week
            """
        )
        held = cursor.fetchone()
    return {
        "configured": configured(),
        "base_url_host": urlparse(settings.hr_base_url).hostname if settings.hr_base_url else None,
        "last_run": dict(last) if last else None,
        **dict(held),
    }


def job_week(cursor: Any, job_key: int, week_start: date) -> dict[str, Any] | None:
    """The held row for one site and week, as the staffing route serves it; None when HR has none."""
    cursor.execute(
        """
        SELECT week_start, hires, separations, budgeted_positions, positions_source, filled_positions,
               open_positions, active_headcount, headcount_source, hr_as_of
        FROM core.hr_site_staffing_week WHERE job_key = %s AND week_start = %s
        """,
        (job_key, week_start),
    )
    return cursor.fetchone()
