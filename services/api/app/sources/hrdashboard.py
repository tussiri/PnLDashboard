"""HrDashboard connector: site positions, headcount, hires and separations by week (migration 053).

HrDashboard serves a read-only machine API, `GET /api/service/v1/pnl/site-staffing?from&to` (bearer
token; HrDashboard docs/ARCHITECTURE.md "Service API"). One row per site per Monday-start week, keyed
by HR's WinTeam tenant ('primary', or a code such as 'SAR') and that tenant's own job number. The
tenant is mapped to the warehouse's WinTeam database ('Crane' | 'Sarus') by HR_TENANT_COMPANIES.

Each pull asks for the last LOOKBACK_WEEKS weeks and upserts them into core.hr_site_staffing_week.
Hires and separations are overwritten; the current-state figures (positions, filled, open, active
headcount) only ever replace a NULL or an older value with a value, never a value with a NULL, so
past weeks keep what HR said while they were current. Runs are recorded in ops.integration_sync_run
(integration 'hrdashboard'). The pulls never write to HrDashboard.

Site billing is the one thing sent the other way (`POST /api/service/v1/pnl/site-billing`, same token):
each job's monthly billing as the leadership views show it (the contract on a contract-basis account,
else the revenue month's amount), for every job that has one. HR budgets its district overtime report from it. It runs
after the marts are rebuilt and is recorded as resource 'site_billing'.

Guard: an answer with no rows changes nothing; HR answering with no sites at all is far likelier to
be an HR problem than every site vanishing, so the run is recorded as failed.

The account listing goes the same way (`POST /api/service/v1/pnl/accounts`, same token): the featured
accounts and the jobs in each, as the leadership views group them (a non-billed job is left out, as it is
'other' there). HR replaces its listing with it and groups its sites, Account filter and reports by it. It
runs after the marts are rebuilt, so jobs assigned on the rebuild go too, and is recorded as resource
'account_listing'. No accounts to send is a failure, since HR refuses an empty listing.

Employee names (`GET /api/service/v1/pnl/employee-names`, migration 064) are a separate pull with their
own token, HR_NAMES_TOKEN: employee number and name, replacing core.hr_employee_name whole, under the same
guard. Names go to the labor hours report only and are never logged or put in a run's error message.
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
NAMES_RESOURCE = "employee_names"
NAMES_PATH = "/api/service/v1/pnl/employee-names"
BILLING_RESOURCE = "site_billing"
BILLING_PATH = "/api/service/v1/pnl/site-billing"
ACCOUNTS_RESOURCE = "account_listing"
ACCOUNTS_PATH = "/api/service/v1/pnl/accounts"
LOOKBACK_WEEKS = 8


class HrDashboardError(RuntimeError):
    pass


def configured() -> bool:
    return bool(settings.hr_base_url and settings.hr_export_token)


def names_configured() -> bool:
    return bool(settings.hr_base_url and settings.hr_names_token)


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


def _record(run_id: str, status: str, started: datetime, fetched: int, loaded: int, error: str | None, resource: str = RESOURCE) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ops.integration_sync_run (id, integration_name, resource_name, status, started_at, completed_at,
                                                  records_fetched, records_inserted, error_message)
            VALUES (%s, %s, %s, %s, %s, now(), %s, %s, %s)
            """,
            (run_id, INTEGRATION, resource, status, started, fetched, loaded, error),
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


def name_row(r: dict[str, Any], companies: dict[str, str]) -> tuple[str, str, str, str] | None:
    """One name tuple, or None for a row whose tenant has no company mapping or which has no number or name."""
    company = companies.get(str(r.get("tenant") or ""))
    number = str(r.get("employeeNumber") or "").strip()
    first, last = str(r.get("firstName") or "").strip(), str(r.get("lastName") or "").strip()
    if not company or not number or not (first or last):
        return None
    return (company, number, first, last)


def fetch_names(client: httpx.Client) -> dict[str, Any]:
    """HR's employee numbers and names. Error messages carry the status only, never the body."""
    response = client.get(NAMES_PATH)
    if response.status_code == 401:
        raise HrDashboardError("HrDashboard refused the names token (HTTP 401)")
    if response.status_code == 503:
        raise HrDashboardError("HrDashboard's names route is not configured (SERVICE_API_NAMES_TOKEN_HASHES unset)")
    if response.status_code >= 400:
        raise HrDashboardError(f"HrDashboard answered HTTP {response.status_code} on {NAMES_PATH}")
    body = response.json()
    if not isinstance(body.get("data"), list):
        raise HrDashboardError(f"Unexpected HrDashboard response on {NAMES_PATH}: no data list")
    return body


def load_names(body: dict[str, Any], companies: dict[str, str]) -> dict[str, int]:
    """Replace the held names in one transaction; an answer with none changes nothing."""
    tuples = {(t[0], t[1]): t for t in (name_row(r, companies) for r in body["data"]) if t is not None}
    if not tuples:
        raise HrDashboardError("HrDashboard returned no employee names with a mapped tenant; nothing was changed")
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("DELETE FROM core.hr_employee_name")
        cursor.executemany("INSERT INTO core.hr_employee_name (winteam_company, employee_number, first_name, last_name) VALUES (%s, %s, %s, %s)",
                           list(tuples.values()))
        conn.commit()
    return {"loaded": len(tuples), "skipped": len(body["data"]) - len(tuples)}


def sync_names() -> dict[str, Any]:
    """Pull and replace the employee names. GET only against HrDashboard. Raises on failure after recording it."""
    if not names_configured():
        raise HrDashboardError("HrDashboard names are not configured (HR_BASE_URL and HR_NAMES_TOKEN)")
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    fetched = 0
    try:
        with httpx.Client(base_url=settings.hr_base_url, timeout=settings.hr_timeout_seconds,
                          headers={"Authorization": f"Bearer {settings.hr_names_token}", "Accept": "application/json"},
                          follow_redirects=False) as client:
            body = fetch_names(client)
        fetched = len(body["data"])
        counts = load_names(body, tenant_companies(settings.hr_tenant_companies))
    except (HrDashboardError, httpx.HTTPError, ValueError) as exc:
        message = str(exc)[:500] or exc.__class__.__name__
        logger.warning("HrDashboard names sync failed: %s", message)
        _record(run_id, "failed", started, fetched, 0, message, NAMES_RESOURCE)
        raise HrDashboardError(message) from exc
    _record(run_id, "succeeded", started, fetched, counts["loaded"], None, NAMES_RESOURCE)
    return {"status": "succeeded", "fetched": fetched, **counts}


# Each job's monthly billing as the leadership views show it (routers/leadership.py ROW_SQL): on an account
# whose invoice basis is the contract, the contract in effect on the week's last day (ops.job_contract, the
# job's company first, then any company), else the job's own AR billed for that month; otherwise, and where
# a job has neither, the revenue month's amount. An account's AR billed on its parent job is not spread over
# its sites here as the views do. The month is the one the week ends in, so HR reads "the billing in effect that month".
#
# Every job goes back under the WinTeam database and number HR knows it by: the job maps give a job's own
# number in its tenant (migrations 012 and 026). HR's staffing feed is not consulted, so a site HR sends no
# staffing for still gets its billing. One row per job and month; the latest week's figure wins.
BILLING_SQL = """
WITH ct AS (
  SELECT company, job_number, monthly_amount, effective_from,
         coalesce(lead(effective_from) OVER (PARTITION BY company, job_number ORDER BY effective_from), 'infinity'::date) AS effective_to
  FROM ops.job_contract
),
cm AS (
  SELECT job_key, service_month, sum(revenue_total) AS ar
  FROM mart.v_ar_invoice_effective
  WHERE service_month >= date_trunc('month', %s::date)::date
  GROUP BY job_key, service_month
),
billed AS (
  SELECT w.job_key, w.week_start, date_trunc('month', w.week_end)::date AS month,
         coalesce(CASE WHEN a.invoice_basis = 'contract'
                       THEN coalesce(ctc.monthly_amount, cta.monthly_amount, nullif(cm.ar, 0)) END,
                  w.revenue_month_amount) AS amount
  FROM mart.leadership_week w
  LEFT JOIN ops.account_job aj ON aj.company = w.company AND aj.job_number = w.job_number
  LEFT JOIN ops.account a ON a.slug = aj.account_slug
  LEFT JOIN ct ctc ON ctc.company = w.company AND ctc.job_number = w.job_number
                  AND w.week_end >= ctc.effective_from AND w.week_end < ctc.effective_to
  LEFT JOIN ct cta ON cta.company = '' AND cta.job_number = w.job_number
                  AND w.week_end >= cta.effective_from AND w.week_end < cta.effective_to
  LEFT JOIN cm ON cm.job_key = w.job_key AND cm.service_month = date_trunc('month', w.week_end)::date
  WHERE w.week_start >= %s
)
SELECT DISTINCT ON (h.winteam_company, h.winteam_job_number, b.month)
       h.winteam_company, h.winteam_job_number, b.month AS revenue_month, b.amount AS revenue_month_amount
FROM billed b
JOIN (
  SELECT 'Crane' AS winteam_company, a.raw_job_number AS winteam_job_number, a.job_key
  FROM mart.v_api_job_map a
  WHERE a.job_key IS NOT NULL AND a.company IS DISTINCT FROM 'Sarus' AND a.raw_job_number NOT LIKE '%%:%%'
  UNION
  SELECT 'Sarus', s.raw_job_number, s.job_key
  FROM mart.v_sarus_job_map s
  WHERE s.job_key IS NOT NULL AND s.company = 'Sarus' AND s.raw_job_number NOT LIKE '%%:%%'
) h ON h.job_key = b.job_key
WHERE b.amount > 0
ORDER BY h.winteam_company, h.winteam_job_number, b.month, b.week_start DESC
"""


def billing_row(r: dict[str, Any], tenants: dict[str, str]) -> dict[str, Any] | None:
    """One row of the body HR takes, or None when the job's company has no HR tenant."""
    tenant = tenants.get(str(r.get("winteam_company") or ""))
    month, amount = r.get("revenue_month"), r.get("revenue_month_amount")
    if not tenant or month is None or amount is None:
        return None
    return {"tenant": tenant, "jobNumber": str(r["winteam_job_number"]), "month": month.isoformat(), "amount": round(float(amount), 2)}


def send_billing(client: httpx.Client, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """POST the rows; HR answers how many it stored and skipped."""
    response = client.post(BILLING_PATH, json={"data": rows})
    if response.status_code == 401:
        raise HrDashboardError("HrDashboard refused the export token (HTTP 401)")
    if response.status_code == 503:
        raise HrDashboardError("HrDashboard's service API is not configured (SERVICE_API_TOKEN_HASHES unset)")
    if response.status_code >= 400:
        raise HrDashboardError(f"HrDashboard answered HTTP {response.status_code} on {BILLING_PATH}")
    body = response.json()
    if not isinstance(body.get("stored"), int):
        raise HrDashboardError(f"Unexpected HrDashboard response on {BILLING_PATH}: no stored count")
    return body


def push_billing() -> dict[str, Any]:
    """Send HR each job's monthly billing for the last LOOKBACK_WEEKS weeks. Nothing to send is not a
    failure. Raises on failure after recording it."""
    if not configured():
        raise HrDashboardError("HrDashboard is not configured (HR_BASE_URL and HR_EXPORT_TOKEN)")
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    tenants = {company: tenant for tenant, company in tenant_companies(settings.hr_tenant_companies).items()}
    rows: list[dict[str, Any]] = []
    try:
        with connection() as conn, conn.cursor() as cursor:
            since = started.date() - timedelta(weeks=LOOKBACK_WEEKS)
            cursor.execute(BILLING_SQL, (since, since))
            rows = [b for b in (billing_row(r, tenants) for r in cursor.fetchall()) if b is not None]
        stored = 0
        if rows:
            with _client() as client:
                stored = send_billing(client, rows)["stored"]
    except (HrDashboardError, httpx.HTTPError, ValueError) as exc:
        message = str(exc)[:500] or exc.__class__.__name__
        logger.warning("HrDashboard billing push failed: %s", message)
        _record(run_id, "failed", started, len(rows), 0, message, BILLING_RESOURCE)
        raise HrDashboardError(message) from exc
    _record(run_id, "succeeded", started, len(rows), stored, None, BILLING_RESOURCE)
    return {"status": "succeeded", "sent": len(rows), "stored": stored}


ACCOUNTS_SQL = "SELECT slug, name, sort FROM ops.account WHERE featured ORDER BY sort, name"

ACCOUNT_JOBS_SQL = """
SELECT aj.company, aj.job_number, aj.account_slug
FROM ops.account_job aj
JOIN ops.account a ON a.slug = aj.account_slug
WHERE a.featured AND aj.role IS DISTINCT FROM 'non_billed' AND aj.job_number NOT LIKE '%:%'
ORDER BY aj.company, aj.job_number
"""


def account_listing(accounts: list[dict[str, Any]], jobs: list[dict[str, Any]], tenants: dict[str, str]) -> dict[str, Any]:
    """The body HR takes. A job whose company has no HR tenant is left out."""
    return {
        "accounts": [{"slug": a["slug"], "name": a["name"], "sort": int(a["sort"])} for a in accounts],
        "jobs": [
            {"tenant": tenants[j["company"]], "jobNumber": str(j["job_number"]), "account": j["account_slug"]}
            for j in jobs
            if j.get("company") in tenants
        ],
    }


def send_accounts(client: httpx.Client, body: dict[str, Any]) -> dict[str, Any]:
    """POST the listing; HR answers how many jobs it stored and skipped."""
    response = client.post(ACCOUNTS_PATH, json=body)
    if response.status_code == 401:
        raise HrDashboardError("HrDashboard refused the export token (HTTP 401)")
    if response.status_code == 503:
        raise HrDashboardError("HrDashboard's service API is not configured (SERVICE_API_TOKEN_HASHES unset)")
    if response.status_code == 404:
        raise HrDashboardError(f"HrDashboard has no {ACCOUNTS_PATH} yet (HTTP 404): deploy HR first")
    if response.status_code >= 400:
        raise HrDashboardError(f"HrDashboard answered HTTP {response.status_code} on {ACCOUNTS_PATH}")
    answer = response.json()
    if not isinstance(answer.get("stored"), int):
        raise HrDashboardError(f"Unexpected HrDashboard response on {ACCOUNTS_PATH}: no stored count")
    return answer


def push_accounts() -> dict[str, Any]:
    """Send HR the featured accounts and their jobs. Raises on failure after recording it."""
    if not configured():
        raise HrDashboardError("HrDashboard is not configured (HR_BASE_URL and HR_EXPORT_TOKEN)")
    started = datetime.now(timezone.utc)
    run_id = str(uuid.uuid4())
    tenants = {company: tenant for tenant, company in tenant_companies(settings.hr_tenant_companies).items()}
    jobs = 0
    try:
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute(ACCOUNTS_SQL)
            accounts = [dict(r) for r in cursor.fetchall()]
            cursor.execute(ACCOUNT_JOBS_SQL)
            body = account_listing(accounts, [dict(r) for r in cursor.fetchall()], tenants)
        jobs = len(body["jobs"])
        if not body["accounts"]:
            raise HrDashboardError("No featured accounts to send")
        with _client() as client:
            stored = send_accounts(client, body)["stored"]
    except (HrDashboardError, httpx.HTTPError, ValueError) as exc:
        message = str(exc)[:500] or exc.__class__.__name__
        logger.warning("HrDashboard account push failed: %s", message)
        _record(run_id, "failed", started, jobs, 0, message, ACCOUNTS_RESOURCE)
        raise HrDashboardError(message) from exc
    _record(run_id, "succeeded", started, jobs, stored, None, ACCOUNTS_RESOURCE)
    return {"status": "succeeded", "accounts": len(body["accounts"]), "sent": jobs, "stored": stored}


def status() -> dict[str, Any]:
    """Whether HrDashboard is wired, the last run, and how much is held. Never returns the token."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT status, completed_at, records_inserted, error_message FROM ops.integration_sync_run
            WHERE integration_name = %s AND resource_name = %s ORDER BY started_at DESC LIMIT 1
            """,
            (INTEGRATION, RESOURCE),
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
        cursor.execute("SELECT count(*) AS employee_names FROM core.hr_employee_name")
        names = cursor.fetchone()
    return {
        "configured": configured(),
        "names_configured": names_configured(),
        **dict(names),
        "base_url_host": urlparse(settings.hr_base_url).hostname if settings.hr_base_url else None,
        "last_run": dict(last) if last else None,
        **dict(held),
    }


# One row per job of an account for one week, on job_week's rule below, except that the positions,
# filled, open and headcount show even in a week HR sent nothing for, from a week up to eight away. A job is matched to HR by its
# job key, else by WinTeam database and job number (an HR row whose key did not resolve still shows).
ACCOUNT_SITES_SQL = """
WITH jobs AS (
  SELECT aj.company, aj.job_number,
         (SELECT w.job_key FROM mart.leadership_week w WHERE w.company = aj.company AND w.job_number = aj.job_number
          ORDER BY w.week_start DESC LIMIT 1) AS job_key
  FROM ops.account_job aj
  WHERE aj.account_slug = %(account)s
),
hr AS (
  SELECT j.company, j.job_number, x.*
  FROM jobs j
  JOIN core.hr_site_staffing_week x
    ON x.job_key = j.job_key OR (x.winteam_company = j.company AND x.winteam_job_number = j.job_number)
)
SELECT j.company, j.job_number, w.week_start, w.hires, w.separations, s.budgeted_positions, s.positions_source,
       s.filled_positions, s.open_positions, s.active_headcount, s.headcount_source,
       coalesce(s.hr_as_of, w.hr_as_of) AS hr_as_of, s.week_start AS state_week
FROM jobs j
LEFT JOIN hr w ON w.company = j.company AND w.job_number = j.job_number AND w.week_start = %(week)s
LEFT JOIN LATERAL (
    SELECT x.week_start, x.budgeted_positions, x.positions_source, x.filled_positions, x.open_positions,
           x.active_headcount, x.headcount_source, x.hr_as_of
    FROM hr x
    WHERE x.company = j.company AND x.job_number = j.job_number
      AND (x.budgeted_positions IS NOT NULL OR x.filled_positions IS NOT NULL
           OR x.open_positions IS NOT NULL OR x.active_headcount IS NOT NULL)
      AND abs(x.week_start - %(week)s::date) <= 56
    ORDER BY x.week_start > %(week)s, abs(x.week_start - %(week)s::date)
    LIMIT 1
) s ON true
ORDER BY j.company, j.job_number
"""


def job_week(cursor: Any, job_key: int, week_start: date) -> dict[str, Any] | None:
    """The held row for one site and week, as the staffing route serves it; None when HR has none.

    HR reports positions, filled, open and headcount only as of when it answers, so a week pulled after it
    ended has hires and separations but none of those. They are taken from the nearest week that has them,
    the latest one up to the week first, else the earliest after it; `state_week` names that week.
    """
    cursor.execute(
        """
        SELECT w.week_start, w.hires, w.separations, s.budgeted_positions, s.positions_source, s.filled_positions,
               s.open_positions, s.active_headcount, s.headcount_source, COALESCE(s.hr_as_of, w.hr_as_of) AS hr_as_of,
               s.week_start AS state_week
        FROM core.hr_site_staffing_week w
        LEFT JOIN LATERAL (
            SELECT x.week_start, x.budgeted_positions, x.positions_source, x.filled_positions, x.open_positions,
                   x.active_headcount, x.headcount_source, x.hr_as_of
            FROM core.hr_site_staffing_week x
            WHERE x.job_key = w.job_key
              AND (x.budgeted_positions IS NOT NULL OR x.filled_positions IS NOT NULL
                   OR x.open_positions IS NOT NULL OR x.active_headcount IS NOT NULL)
            ORDER BY x.week_start > w.week_start, abs(x.week_start - w.week_start)
            LIMIT 1
        ) s ON true
        WHERE w.job_key = %s AND w.week_start = %s
        """,
        (job_key, week_start),
    )
    return cursor.fetchone()
