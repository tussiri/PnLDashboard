"""Endpoint-aware connector for the documented TEAM/WinTeam ("wtnextgen") GET API.

Every path, parameter, header and response field used here comes from WinTeamAPI.txt. The
connector never writes to WinTeam (the documented POST /jobs/{jobKey}/budgets is deliberately
absent) and never runs inside a browser request: the worker or an admin call drives it.

Data rules
----------
* Every call sends the `tenantId` header. The Azure API Management gateway key (default header
  `Ocp-Apim-Subscription-Key`) is sent only when configured. Headers are never logged.
* Paged endpoints return `{"data":[{pageNumber,pageSize,totalPages,totalCount,results:[...]}]}`.
  Pages are walked 1..totalPages and stop early on an empty page. HTTP 204 means "no records".
* GL budgets return `{"data":[{jobNumber,fiscalYear,glBudgetId,glBudgetDetails:[...]}]}` with no
  paging; each detail row is flattened into its own raw record carrying the header fields.
* Date-windowed resources (timekeeping, AP invoices, AP payments, schedules) are pulled in
  WINTEAM_WINDOW_DAYS chunks from (watermark - WINTEAM_LOOKBACK_DAYS) or, on the first run,
  (today - WINTEAM_BACKFILL_MONTHS) through today. Dates are sent as RFC3339 UTC timestamps.
* The watermark for a resource is the ISO date of the last fully synced window end and is only
  advanced after the whole run succeeded.
* Raw payloads are landed unchanged in raw.winteam_record; an identical payload for the same record
  is a no-op, a changed payload creates a new version. Normalization reads the latest version.
* 400/422 responses carry `{"errors":[{fieldName,errorMessage,attemptedValue}]}`; the field errors
  are surfaced in the failure message so a misconfigured tenant id is diagnosable.
* Entitlements: an HTTP 403 on a resource means the tenant's subscription does not include that
  endpoint (verified 2026-09-03: job_schedules and ap_payments). The run is recorded as `failed`
  with error_message "not_entitled: HTTP 403", status() reports `entitled: false` for the
  resource, and sync_all carries on with the remaining resources.
* GL budgets: HTTP 404 and HTTP 400 "Invalid Job Number and Fiscal Year combination" both mean
  "no budget for this job / fiscal year" and are not failures.
* Receivables customer numbers are the union of WINTEAM_CUSTOMER_NUMBERS and every
  core.dim_customer.customer_number (any source, e.g. "AMAZ01" from the finance_reference load);
  they are passed through as strings, never re-formatted. The live endpoint does not echo
  customerNumber inside each invoice record (the documentation sample does), so the queried
  number is written into the record before it is landed.
* `sync(resource, normalize=False)` / `sync_all(normalize=False)` and WINTEAM_NORMALIZE=false land
  raw payloads only; normalization (normalize.py) is a separate, idempotent step. Bounded pulls
  (`start_date`, `customer_numbers`, `jobs_limit` overrides) never advance the watermark.

Database sessions
-----------------
No transaction may span an HTTP fetch. A pull holds one connection for its duration, but the
session is in autocommit: reads (the active job numbers, the customer numbers) stand alone and
`_land` opens a short transaction per batch. Anything else leaves the session `idle in
transaction` while WinTeam is slow, holding locks on core.* against the mart rebuild and, behind
it, every reporting read. `WINTEAM_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS` (default 60) is the
server-side backstop if that invariant is ever broken again, not the fix for it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from .config import RESOURCE_NAMES, Settings, settings
from .db import connection

logger = logging.getLogger("winteam")
INTEGRATION = "winteam"
RETRYABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
NOT_ENTITLED = "not_entitled"
# Text of the documented 400 the gl-budgets endpoint returns for a job/year without a budget.
GL_NO_BUDGET_TEXT = "invalid job number and fiscal year"


class WinTeamError(RuntimeError):
    """A WinTeam request or response could not be used."""

    def __init__(self, message: str, status_code: int | None = None, errors: list[dict[str, Any]] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.errors = errors or []


# ── resource catalogue ───────────────────────────────────────────────────────
def _text(record: dict[str, Any], key: str) -> str:
    value = record.get(key)
    return "" if value is None else str(value).strip()


def _require(record: dict[str, Any], *keys: str) -> list[str]:
    values = [_text(record, key) for key in keys]
    missing = [key for key, value in zip(keys, values) if value == ""]
    if missing:
        raise WinTeamError(f"record is missing required id field(s): {', '.join(missing)}")
    return values


def id_timekeeping(record: dict[str, Any]) -> str:
    return _require(record, "timekeepingId")[0]


def id_jobs(record: dict[str, Any]) -> str:
    return _text(record, "jobId") or _require(record, "jobNumber")[0]


def id_job_schedules(record: dict[str, Any]) -> str:
    return _require(record, "id")[0]


def id_gl_budgets(record: dict[str, Any]) -> str:
    job_number, fiscal_year, detail_id = _require(record, "jobNumber", "fiscalYear", "id")
    return f"{job_number}:{fiscal_year}:{detail_id}"


def id_ap_invoices(record: dict[str, Any]) -> str:
    _require(record, "invoiceNumber")
    return f"{_text(record, 'companyNumber')}:{_text(record, 'vendorNumber')}:{_text(record, 'invoiceNumber')}"


def id_ar_invoices(record: dict[str, Any]) -> str:
    customer_number, invoice_number = _require(record, "customerNumber", "invoiceNumber")
    return f"{customer_number}:{invoice_number}"


def id_ap_payments(record: dict[str, Any]) -> str:
    return _require(record, "paymentId")[0]


def id_vendors(record: dict[str, Any]) -> str:
    return _require(record, "vendorNumber")[0]


@dataclass(frozen=True)
class Resource:
    name: str
    path: str
    kind: str  # list | date_window | per_job | per_job_date_window | per_customer
    envelope: str  # paged | data_array
    record_id: Callable[[dict[str, Any]], str]
    description: str
    date_params: tuple[str, str] | None = None

    @property
    def date_windowed(self) -> bool:
        return self.kind in {"date_window", "per_job_date_window"}


RESOURCES: dict[str, Resource] = {
    "jobs": Resource(
        "jobs", "/jobs/v2/api/jobs", "list", "paged", id_jobs,
        "All jobs (optionally filtered by locationId). Feeds core.dim_job and the per-job pulls.",
    ),
    "vendors": Resource(
        "vendors", "/vendors/v1/api/vendors/", "list", "paged", id_vendors,
        "Vendors and contacts. Feeds core.dim_vendor (names for AP views).",
    ),
    "timekeeping": Resource(
        "timekeeping", "/timekeeping/v2/api/timekeeping", "date_window", "paged", id_timekeeping,
        "Timekeeping punches by workDate window.", ("dateFrom", "dateTo"),
    ),
    "job_schedules": Resource(
        "job_schedules", "/jobs/v2/api/jobs/{jobKey}/schedules", "per_job_date_window", "paged", id_job_schedules,
        "Scheduled shifts per active job and date window.", ("dateFrom", "dateTo"),
    ),
    "gl_budgets": Resource(
        "gl_budgets", "/jobs/v2/api/jobs/{jobKey}/gl-budgets", "per_job", "data_array", id_gl_budgets,
        "GL budgets per active job and fiscal year; glBudgetDetails are flattened one row per record.",
    ),
    "ap_invoices": Resource(
        "ap_invoices", "/accounts/v1/api/payables/invoices", "date_window", "paged", id_ap_invoices,
        "Accounts payable invoices by date window.", ("dateFrom", "dateTo"),
    ),
    "ar_invoices": Resource(
        "ar_invoices", "/accounts/v1/api/receivables/invoices/", "per_customer", "paged", id_ar_invoices,
        "Accounts receivable invoices; the endpoint requires a customerNumber per call.",
    ),
    "ap_payments": Resource(
        "ap_payments", "/accounts/v1/api/payables/payments", "date_window", "paged", id_ap_payments,
        "Accounts payable payments by check date (paymentDateAdded when no check date).", ("startDate", "endDate"),
    ),
}
assert tuple(RESOURCES) == RESOURCE_NAMES


# ── envelope parsing (pure) ──────────────────────────────────────────────────
@dataclass(frozen=True)
class Page:
    page_number: int
    total_pages: int
    total_count: int | None
    results: list[dict[str, Any]]


def error_message(status_code: int | None, payload: Any) -> str:
    """Human readable failure built from the documented ErrorResponse shape."""
    prefix = f"WinTeam returned HTTP {status_code}" if status_code else "WinTeam request failed"
    if not isinstance(payload, dict):
        return prefix
    parts: list[str] = []
    server_response = payload.get("serverResponse")
    if server_response:
        parts.append(str(server_response))
    for item in payload.get("errors") or []:
        if not isinstance(item, dict):
            continue
        detail = f"{item.get('fieldName') or 'field'}: {item.get('errorMessage') or 'invalid'}"
        if item.get("attemptedValue") not in (None, ""):
            detail += f" (attempted value: {item['attemptedValue']})"
        parts.append(detail)
    return f"{prefix}: {'; '.join(parts)}" if parts else prefix


def field_errors(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    return [item for item in payload.get("errors") or [] if isinstance(item, dict)]


def is_not_entitled(exc: BaseException) -> bool:
    """HTTP 403 = the subscription does not include the endpoint (a tenant fact, not a bug)."""
    return isinstance(exc, WinTeamError) and exc.status_code == 403


def not_entitled_message(exc: WinTeamError) -> str:
    return f"{NOT_ENTITLED}: HTTP {exc.status_code}"


def is_no_gl_budget(exc: BaseException) -> bool:
    """True for the two documented "no budget for this job / fiscal year" answers of gl-budgets.

    404 is documented; the live tenant answers 400 with a JobKey field error "Invalid Job Number
    and Fiscal Year combination." for jobs that simply have no budget in that year.
    """
    if not isinstance(exc, WinTeamError):
        return False
    if exc.status_code == 404:
        return True
    if exc.status_code != 400:
        return False
    texts = [str(item.get("errorMessage") or "") for item in exc.errors] + [str(exc)]
    return any(GL_NO_BUDGET_TEXT in text.lower() for text in texts)


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_paged(payload: Any) -> Page:
    """Parse the documented paged envelope. `None` (HTTP 204) is an empty page."""
    if payload is None:
        return Page(1, 1, 0, [])
    if not isinstance(payload, dict):
        raise WinTeamError("WinTeam returned a non-object JSON body")
    if payload.get("success") is False:
        raise WinTeamError(error_message(None, payload), errors=field_errors(payload))
    data = payload.get("data")
    blocks = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
    if not blocks:
        return Page(1, 1, 0, [])
    results: list[dict[str, Any]] = []
    page_number, total_pages, total_count = 1, 1, None
    for block in blocks:
        if not isinstance(block, dict):
            raise WinTeamError("WinTeam paged envelope contains a non-object data block")
        block_results = block.get("results") or []
        if not isinstance(block_results, list):
            raise WinTeamError("WinTeam paged envelope has a non-array results field")
        results.extend(item for item in block_results if isinstance(item, dict))
        page_number = _to_int(block.get("pageNumber"), page_number)
        total_pages = max(total_pages, _to_int(block.get("totalPages"), 1))
        if block.get("totalCount") is not None:
            total_count = (total_count or 0) + _to_int(block.get("totalCount"), 0)
    return Page(page_number, total_pages, total_count, results)


def parse_data_array(payload: Any) -> list[dict[str, Any]]:
    """Parse the non-paged `{"data":[...]}` envelope used by GL budgets."""
    if payload is None:
        return []
    if not isinstance(payload, dict):
        raise WinTeamError("WinTeam returned a non-object JSON body")
    if payload.get("success") is False:
        raise WinTeamError(error_message(None, payload), errors=field_errors(payload))
    data = payload.get("data")
    if data is None:
        return []
    if isinstance(data, dict):
        return [data]
    if not isinstance(data, list):
        raise WinTeamError("WinTeam data envelope is not an array")
    return [item for item in data if isinstance(item, dict)]


def flatten_gl_budget(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """One raw record per glBudgetDetails element, carrying jobNumber/fiscalYear/glBudgetId."""
    header = {key: entry.get(key) for key in ("jobNumber", "fiscalYear", "glBudgetId")}
    details = entry.get("glBudgetDetails") or []
    if not isinstance(details, list):
        return []
    return [{**header, **detail} for detail in details if isinstance(detail, dict)]


# ── window and watermark arithmetic (pure) ───────────────────────────────────
def rfc3339_start(value: date) -> str:
    return f"{value.isoformat()}T00:00:00Z"


def rfc3339_end(value: date) -> str:
    return f"{value.isoformat()}T23:59:59Z"


def months_before(value: date, months: int) -> date:
    """Same day-of-month `months` earlier, clamped to the shorter month; then the 1st of that month."""
    index = value.year * 12 + (value.month - 1) - months
    return date(index // 12, index % 12 + 1, 1)


def window_start(watermark: str | None, today: date, backfill_months: int, lookback_days: int) -> date:
    """First day to pull: watermark minus lookback, or the backfill start on a first run."""
    if watermark:
        try:
            anchor = date.fromisoformat(watermark[:10])
        except ValueError:
            anchor = None
        if anchor is not None:
            return min(anchor - timedelta(days=lookback_days), today)
    return months_before(today, backfill_months)


def date_windows(start: date, end: date, window_days: int) -> list[tuple[date, date]]:
    """Inclusive, contiguous, non-overlapping windows of at most `window_days` days."""
    if window_days < 1:
        raise ValueError("window_days must be positive")
    windows: list[tuple[date, date]] = []
    cursor = start
    while cursor <= end:
        stop = min(end, cursor + timedelta(days=window_days - 1))
        windows.append((cursor, stop))
        cursor = stop + timedelta(days=1)
    return windows


def fiscal_years(today: date, count: int) -> list[int]:
    """Calendar years probed for GL budgets: this year and `count - 1` previous years."""
    return [today.year - offset for offset in range(max(count, 1))]


# ── entitlement and scoping helpers (pure) ───────────────────────────────────
def entitlement_from_run(run: dict[str, Any] | None) -> bool | None:
    """True/False from a resource's latest run row; None when the resource has never been synced."""
    if not run or not run.get("status"):
        return None
    if run.get("status") == "failed" and str(run.get("error_message") or "").startswith(NOT_ENTITLED):
        return False
    return True


def merge_customer_numbers(configured: Sequence[str], known: Sequence[str]) -> list[str]:
    """Ordered union (configured first) of customer numbers, trimmed, duplicates removed, unchanged otherwise."""
    merged: list[str] = []
    for number in [*configured, *known]:
        text = str(number).strip() if number is not None else ""
        if text and text not in merged:
            merged.append(text)
    return merged


# ── HTTP client ──────────────────────────────────────────────────────────────
def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


class WinTeamClient:
    """Thin httpx wrapper: retries, envelope parsing and page walking. Never logs headers."""

    def __init__(
        self,
        base_url: str,
        headers: dict[str, str],
        timeout: float = 30,
        max_retries: int = 4,
        page_size: int = 100,
        max_pages: int = 500,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            follow_redirects=False,
            transport=transport,
        )
        self.max_retries = max_retries
        self.page_size = page_size
        self.max_pages = max_pages
        self._sleep = sleep
        self.requests_made = 0

    def __enter__(self) -> "WinTeamClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """GET and decode. Returns None for 204. Retries 429/5xx/transport errors with backoff."""
        attempt = 0
        while True:
            self.requests_made += 1
            try:
                response = self._client.get(path, params=params)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt >= self.max_retries:
                    raise WinTeamError(f"WinTeam request failed after {attempt + 1} attempt(s): {exc.__class__.__name__}") from exc
                self._backoff(attempt, None, f"{exc.__class__.__name__} on {path}")
                attempt += 1
                continue
            status = response.status_code
            if status == 204:
                return None
            if status in RETRYABLE_STATUSES:
                if attempt >= self.max_retries:
                    raise WinTeamError(error_message(status, _safe_json(response)), status_code=status)
                self._backoff(attempt, response.headers.get("Retry-After"), f"HTTP {status} on {path}")
                attempt += 1
                continue
            if status >= 400:
                payload = _safe_json(response)
                raise WinTeamError(error_message(status, payload), status_code=status, errors=field_errors(payload))
            if status in (301, 302, 303, 307, 308):
                raise WinTeamError(f"WinTeam redirected (HTTP {status}); check WINTEAM_BASE_URL", status_code=status)
            try:
                return response.json()
            except ValueError as exc:
                raise WinTeamError(f"WinTeam returned a non-JSON body (HTTP {status})") from exc

    def _backoff(self, attempt: int, retry_after: str | None, reason: str) -> None:
        delay = _retry_after_seconds(retry_after)
        if delay is None:
            delay = min(30.0, 0.5 * (2**attempt))
        logger.warning("WinTeam retry %s/%s after %.1fs: %s", attempt + 1, self.max_retries, delay, reason)
        self._sleep(delay)

    def iter_pages(self, path: str, params: dict[str, Any] | None = None) -> Iterator[Page]:
        """Walk pageNumber 1..totalPages for one listing; stops on an empty page or max_pages."""
        page_number = 1
        while True:
            if page_number > self.max_pages:
                raise WinTeamError(f"Listing {path} exceeded WINTEAM_MAX_PAGES_PER_SYNC ({self.max_pages})")
            query = {**(params or {}), "pageSize": self.page_size, "pageNumber": page_number}
            page = parse_paged(self.get(path, query))
            yield page
            if not page.results or page_number >= page.total_pages:
                return
            page_number += 1


# ── ingestion ────────────────────────────────────────────────────────────────
@dataclass
class PullResult:
    fetched: int = 0
    inserted: int = 0
    requests: int = 0
    windows: int = 0
    message: str | None = None
    seen_ids: list[str] = field(default_factory=list)
    scope: dict[str, Any] = field(default_factory=dict)  # bounded-pull overrides that were applied


@dataclass(frozen=True)
class PullOptions:
    """Per-call overrides for a bounded pull (validation runs); None = configured behaviour."""

    customer_numbers: tuple[str, ...] | None = None  # ar_invoices: only these customer numbers
    start_date: date | None = None                   # date-windowed resources: first day to pull
    jobs_limit: int | None = None                    # per-job resources: at most this many jobs

    @property
    def bounded(self) -> bool:
        return self.customer_numbers is not None or self.start_date is not None or self.jobs_limit is not None


def canonical_json(record: dict[str, Any]) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), default=str)


class WinTeamIngestion:
    def __init__(self, config: Settings | None = None) -> None:
        self.config = config or settings

    # ── public API ───────────────────────────────────────────────────────────
    def enabled_resources(self) -> list[Resource]:
        return [RESOURCES[name] for name in self.config.winteam_resources]

    def status(self) -> dict[str, Any]:
        latest = self._latest_runs()
        watermarks = self._watermarks()
        resources = []
        for name, resource in RESOURCES.items():
            run = latest.get(name) or {}
            resources.append(
                {
                    "name": name,
                    "enabled": name in self.config.winteam_resources,
                    "kind": resource.kind,
                    "last_status": run.get("status"),
                    "last_completed_at": run["completed_at"].isoformat() if run.get("completed_at") else None,
                    "records_fetched": run.get("records_fetched"),
                    "watermark": watermarks.get(name),
                    "entitled": entitlement_from_run(run),
                }
            )
        return {
            "enabled": self.config.winteam_enabled,
            "configured": self.config.winteam_configured,
            "base_url_host": self.config.winteam_base_url_host,
            "normalize_enabled": self.config.winteam_normalize,
            "resources": resources,
            "poll_seconds": self.config.poll_seconds,
        }

    def test_connection(self) -> dict[str, Any]:
        """Probe page 1 (pageSize=1) of jobs, or the first enabled dependency-free resource."""
        self._require_enabled()
        resource = self._probe_resource()
        params = self._probe_params(resource)
        with self._client() as client:
            page = parse_paged(client.get(resource.path, {**params, "pageSize": 1, "pageNumber": 1}))
        return {"ok": True, "resource": resource.name, "records_in_probe": len(page.results), "total_count": page.total_count}

    def sync(
        self,
        resource_name: str,
        normalize: bool | None = None,
        *,
        customer_numbers: Sequence[str] | None = None,
        start_date: date | None = None,
        jobs_limit: int | None = None,
    ) -> dict[str, Any]:
        """Pull one resource into raw, then (optionally) promote it into core. Never raises for pull failures.

        normalize: None = WINTEAM_NORMALIZE. The keyword overrides bound a validation pull (only these
        receivables customers / from this date / at most this many jobs); a bounded pull is recorded
        with its scope on the run row and does not advance the watermark.
        """
        self._require_enabled()
        resource = RESOURCES.get(resource_name)
        if resource is None:
            raise KeyError(resource_name)
        if resource_name not in self.config.winteam_resources:
            raise WinTeamError(f"Resource {resource_name} is not enabled (WINTEAM_RESOURCES)")
        if normalize is None:
            normalize = self.config.winteam_normalize
        options = PullOptions(
            customer_numbers=tuple(str(n).strip() for n in customer_numbers if str(n).strip()) if customer_numbers is not None else None,
            start_date=start_date,
            jobs_limit=jobs_limit,
        )

        run_id = self._start_run(resource.name)
        today = date.today()
        result = PullResult()
        try:
            with self._client() as client, self._connection(autocommit=True) as conn:
                result = self._pull(resource, client, conn, run_id, today, options)
            self._finish_run(run_id, "succeeded", result, None if options.bounded else today.isoformat())
        except Exception as exc:  # noqa: BLE001 - every failure is recorded on the run row
            if is_not_entitled(exc):
                error = not_entitled_message(exc)  # type: ignore[arg-type]
                self._finish_run(run_id, "failed", result, None, error=f"{error}; {str(exc)[:900]}")
                logger.warning("WinTeam %s is not entitled for this tenant (HTTP 403); skipping", resource.name)
                return self._result(run_id, resource, "failed", result, error=error, entitled=False)
            self._finish_run(run_id, "failed", result, None, error=str(exc)[:1000])
            logger.exception("WinTeam sync failed for %s", resource.name)
            return self._result(run_id, resource, "failed", result, error=str(exc)[:500])
        logger.info(
            "WinTeam %s: fetched=%s inserted=%s requests=%s windows=%s normalize=%s",
            resource.name, result.fetched, result.inserted, result.requests, result.windows, normalize,
        )
        response = self._result(run_id, resource, "succeeded", result, entitled=True)
        if normalize:
            response["normalized"] = self._normalize(resource, result, run_id)
        return response

    def sync_all(self, normalize: bool | None = None, resources: Sequence[str] | None = None) -> dict[str, Any]:
        """Sync the enabled resources in dependency order (a 403 skips only that resource).

        normalize: None = WINTEAM_NORMALIZE. The marts are rebuilt only when normalization ran, because
        a raw-only sync changes nothing the marts read. `resources` restricts the run to a subset of
        the enabled resources (canonical order is kept).
        """
        self._require_enabled()
        if normalize is None:
            normalize = self.config.winteam_normalize
        selected = self.enabled_resources()
        if resources is not None:
            wanted = {str(name).strip().lower() for name in resources}
            unknown = sorted(wanted - set(RESOURCES))
            if unknown:
                raise WinTeamError(f"Unknown resource(s): {', '.join(unknown)}; valid names: {', '.join(RESOURCES)}")
            selected = [resource for resource in selected if resource.name in wanted]
        runs = [self.sync(resource.name, normalize=normalize) for resource in selected]
        not_entitled = [run["resource"] for run in runs if run.get("entitled") is False]
        if not normalize:
            return {"runs": runs, "marts": None, "normalized": False, "not_entitled": not_entitled}
        from . import marts

        try:
            rebuilt: Any = marts.rebuild_all(initiated_by="winteam-sync")
        except Exception as exc:  # noqa: BLE001
            logger.exception("Mart rebuild failed after sync")
            rebuilt = {"error": str(exc)[:500]}
        return {"runs": runs, "marts": rebuilt, "normalized": True, "not_entitled": not_entitled}

    # ── pull strategies ──────────────────────────────────────────────────────
    def _pull(
        self, resource: Resource, client: WinTeamClient, conn: Any, run_id: UUID, today: date, options: PullOptions | None = None
    ) -> PullResult:
        options = options or PullOptions()
        result = PullResult()
        if options.start_date is not None and resource.date_windowed:
            result.scope["start_date"] = options.start_date.isoformat()
        kind = resource.kind
        if kind == "list":
            self._pull_list(resource, client, conn, run_id, result)
        elif kind == "date_window":
            for start, stop in self._windows(resource, today, options.start_date):
                result.windows += 1
                self._pull_pages(resource, client, conn, run_id, resource.path, self._date_params(resource, start, stop), result)
        elif kind == "per_job":
            self._pull_per_job(resource, client, conn, run_id, result, today, options)
        elif kind == "per_job_date_window":
            self._pull_per_job_windows(resource, client, conn, run_id, result, today, options)
        elif kind == "per_customer":
            self._pull_per_customer(resource, client, conn, run_id, result, options)
        else:  # pragma: no cover - guarded by the catalogue
            raise WinTeamError(f"Unknown resource kind {kind}")
        result.requests = client.requests_made
        return result

    def _pull_list(self, resource: Resource, client: WinTeamClient, conn: Any, run_id: UUID, result: PullResult) -> None:
        if resource.name == "jobs" and self.config.winteam_location_ids:
            for location_id in self.config.winteam_location_ids:
                self._pull_pages(resource, client, conn, run_id, resource.path, {"locationId": location_id}, result)
        else:
            self._pull_pages(resource, client, conn, run_id, resource.path, {}, result)

    def _pull_per_job(
        self, resource: Resource, client: WinTeamClient, conn: Any, run_id: UUID, result: PullResult, today: date, options: PullOptions
    ) -> None:
        limit = self.config.winteam_gl_jobs_limit if options.jobs_limit is None else max(0, options.jobs_limit)
        jobs = self._active_job_numbers(conn, limit)
        if options.jobs_limit is not None:
            result.scope["jobs_limit"] = limit
        years = fiscal_years(today, self.config.winteam_gl_fiscal_years)
        if not jobs:
            result.message = "No active jobs in core.dim_job yet; sync jobs first"
        no_budget = 0
        for index, job_number in enumerate(jobs, start=1):
            path = resource.path.format(jobKey=quote(job_number, safe=""))
            for year in years:
                try:
                    payload = client.get(path, {"fiscalYear": year})
                except WinTeamError as exc:
                    if is_no_gl_budget(exc):  # 404, or 400 "Invalid Job Number and Fiscal Year combination"
                        no_budget += 1
                        continue
                    raise
                records = [record for entry in parse_data_array(payload) for record in flatten_gl_budget(entry)]
                for record in records:
                    record.setdefault("jobNumber", job_number)
                    record.setdefault("fiscalYear", year)
                self._land(conn, run_id, resource, records, result)
            if index % 25 == 0:
                logger.info("WinTeam %s: %s/%s jobs processed", resource.name, index, len(jobs))
        if jobs:
            result.message = f"{len(jobs)} job(s) x {len(years)} fiscal year(s) probed; {no_budget} job-year(s) without a budget"

    def _pull_per_job_windows(
        self, resource: Resource, client: WinTeamClient, conn: Any, run_id: UUID, result: PullResult, today: date, options: PullOptions
    ) -> None:
        limit = self.config.winteam_schedule_jobs_limit if options.jobs_limit is None else max(0, options.jobs_limit)
        jobs = self._active_job_numbers(conn, limit)
        if options.jobs_limit is not None:
            result.scope["jobs_limit"] = limit
        windows = self._windows(resource, today, options.start_date)
        result.windows = len(windows)
        if not jobs:
            result.message = "No active jobs in core.dim_job yet; sync jobs first"
        for index, job_number in enumerate(jobs, start=1):
            path = resource.path.format(jobKey=quote(job_number, safe=""))
            for start, stop in windows:
                self._pull_pages(resource, client, conn, run_id, path, self._date_params(resource, start, stop), result)
            if index % 25 == 0:
                logger.info("WinTeam %s: %s/%s jobs processed", resource.name, index, len(jobs))

    def _pull_per_customer(
        self, resource: Resource, client: WinTeamClient, conn: Any, run_id: UUID, result: PullResult, options: PullOptions
    ) -> None:
        if options.customer_numbers is not None:
            customers = list(dict.fromkeys(options.customer_numbers))
            result.scope["customer_numbers"] = customers
        else:
            customers = self._customer_numbers(conn)
        if not customers:
            result.message = (
                "No customer numbers available: the receivables endpoint requires customerNumber. "
                "Set WINTEAM_CUSTOMER_NUMBERS (comma separated) to enable AR ingestion."
            )
            return
        for customer_number in customers:
            # The live endpoint omits customerNumber from each record (the documented sample carries it);
            # the record id is customerNumber:invoiceNumber, so the queried number is filled in when absent.
            self._pull_pages(
                resource, client, conn, run_id, resource.path, {"customerNumber": customer_number}, result,
                defaults={"customerNumber": customer_number},
            )

    def _pull_pages(
        self,
        resource: Resource,
        client: WinTeamClient,
        conn: Any,
        run_id: UUID,
        path: str,
        params: dict[str, Any],
        result: PullResult,
        defaults: dict[str, Any] | None = None,
    ) -> None:
        for page in client.iter_pages(path, params):
            records = page.results
            if defaults:
                records = [{**defaults, **record} for record in records]
                for record in records:
                    for key, value in defaults.items():
                        if record.get(key) in (None, ""):
                            record[key] = value
            self._land(conn, run_id, resource, records, result)

    # ── helpers ──────────────────────────────────────────────────────────────
    def _connection(self, *, autocommit: bool = False) -> Any:
        """Every DB session this connector opens, with the idle-in-transaction backstop applied."""
        return connection(
            autocommit=autocommit,
            idle_in_transaction_timeout_ms=self.config.ingestion_idle_in_transaction_timeout_seconds * 1000,
        )

    def _client(self) -> WinTeamClient:
        return WinTeamClient(
            base_url=self.config.winteam_base_url,
            headers=self.config.winteam_headers(),
            timeout=self.config.request_timeout_seconds,
            max_retries=self.config.max_retries,
            page_size=self.config.winteam_page_size,
            max_pages=self.config.max_pages_per_sync,
        )

    def _require_enabled(self) -> None:
        if not self.config.winteam_enabled:
            raise WinTeamError("WinTeam ingestion is disabled (WINTEAM_ENABLED=false)")
        if not self.config.winteam_configured:
            raise WinTeamError("WinTeam is not configured: set WINTEAM_BASE_URL and WINTEAM_TENANT_ID")

    def _probe_resource(self) -> Resource:
        for name in ("jobs", "vendors", "timekeeping", "ap_invoices", "ap_payments"):
            if name in self.config.winteam_resources:
                return RESOURCES[name]
        return RESOURCES["jobs"]

    def _probe_params(self, resource: Resource) -> dict[str, Any]:
        if resource.date_params:
            today = date.today()
            return self._date_params(resource, today - timedelta(days=7), today)
        if resource.name == "jobs" and self.config.winteam_location_ids:
            return {"locationId": self.config.winteam_location_ids[0]}
        return {}

    def _date_params(self, resource: Resource, start: date, stop: date) -> dict[str, str]:
        assert resource.date_params is not None
        from_name, to_name = resource.date_params
        return {from_name: rfc3339_start(start), to_name: rfc3339_end(stop)}

    def _windows(self, resource: Resource, today: date, start_date: date | None = None) -> list[tuple[date, date]]:
        if start_date is not None:
            start = min(start_date, today)
        else:
            start = window_start(
                self._read_watermark(resource.name), today, self.config.winteam_backfill_months, self.config.winteam_lookback_days
            )
        return date_windows(start, today, self.config.winteam_window_days)

    def _active_job_numbers(self, conn: Any, limit: int = 0) -> list[str]:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT job_number FROM core.dim_job
                WHERE valid_to IS NULL AND is_active AND job_number IS NOT NULL
                ORDER BY job_number
                """
            )
            numbers = [row["job_number"] for row in cursor.fetchall()]
        return numbers[:limit] if limit > 0 else numbers

    def _customer_numbers(self, conn: Any) -> list[str]:
        """WINTEAM_CUSTOMER_NUMBERS union core.dim_customer.customer_number (every source), as strings.

        Customer numbers are opaque text ("AMAZ01", "342"): they are trimmed but never re-cased,
        zero-padded or converted, because the receivables endpoint matches them literally.
        """
        configured = [str(n).strip() for n in self.config.winteam_customer_numbers if str(n).strip()]
        with conn.cursor() as cursor:
            if configured:
                cursor.execute(
                    """
                    INSERT INTO core.dim_customer (customer_number, source)
                    SELECT n, 'config' FROM unnest(%s::text[]) AS n
                    ON CONFLICT (customer_number) DO NOTHING
                    """,
                    (configured,),
                )
            cursor.execute("SELECT customer_number FROM core.dim_customer ORDER BY customer_number")
            known = [str(row["customer_number"]).strip() for row in cursor.fetchall() if row["customer_number"]]
        return merge_customer_numbers(configured, known)

    def _land(self, conn: Any, run_id: UUID, resource: Resource, records: Sequence[dict[str, Any]], result: PullResult) -> None:
        """Insert new payload versions; identical payloads are ignored.

        The batch is its own short transaction on an autocommit session, so nothing stays locked
        while the connector is out fetching the next page (see the module docstring).
        """
        if not records:
            return
        with conn.transaction(), conn.cursor() as cursor:
            for record in records:
                source_id = resource.record_id(record)
                canonical = canonical_json(record)
                digest = hashlib.sha256(canonical.encode()).hexdigest()
                cursor.execute(
                    """
                    INSERT INTO raw.winteam_record
                      (sync_run_id, resource_name, source_record_id, source_updated_at, payload_hash, payload)
                    VALUES (%s, %s, %s, NULL, %s, %s::jsonb)
                    ON CONFLICT (resource_name, source_record_id, payload_hash) DO NOTHING
                    """,
                    (run_id, resource.name, source_id, digest, canonical),
                )
                result.inserted += cursor.rowcount
                result.fetched += 1
                if resource.name == "jobs":
                    result.seen_ids.append(source_id)

    def _normalize(self, resource: Resource, result: PullResult, run_id: UUID) -> int | None:
        from . import normalize

        try:
            seen = result.seen_ids if resource.name == "jobs" else None
            return normalize.normalize_resource(resource.name, seen_ids=seen)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Normalization failed for %s", resource.name)
            self._annotate_run(run_id, f"normalization failed: {str(exc)[:800]}")
            return None

    @staticmethod
    def _result(
        run_id: UUID, resource: Resource, status: str, result: PullResult, error: str | None = None, entitled: bool | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "run_id": str(run_id),
            "resource": resource.name,
            "status": status,
            "fetched": result.fetched,
            "inserted": result.inserted,
            "normalized": None,
            "requests": result.requests,
            "windows": result.windows,
        }
        if entitled is not None:
            payload["entitled"] = entitled
        if result.scope:
            payload["scope"] = dict(result.scope)
        if result.message:
            payload["message"] = result.message
        if error:
            payload["error"] = error
        return payload

    # ── ops tables ───────────────────────────────────────────────────────────
    def _latest_runs(self) -> dict[str, dict[str, Any]]:
        with self._connection() as conn, conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT DISTINCT ON (resource_name) resource_name, status, completed_at, records_fetched, error_message
                FROM ops.integration_sync_run
                WHERE integration_name = %s
                ORDER BY resource_name, started_at DESC
                """,
                (INTEGRATION,),
            )
            return {row["resource_name"]: row for row in cursor.fetchall()}

    def _watermarks(self) -> dict[str, str]:
        with self._connection() as conn, conn.cursor() as cursor:
            cursor.execute("SELECT resource_name, watermark_value FROM ops.source_watermark WHERE integration_name = %s", (INTEGRATION,))
            return {row["resource_name"]: row["watermark_value"] for row in cursor.fetchall()}

    def _read_watermark(self, resource_name: str) -> str | None:
        with self._connection() as conn, conn.cursor() as cursor:
            cursor.execute(
                "SELECT watermark_value FROM ops.source_watermark WHERE integration_name = %s AND resource_name = %s",
                (INTEGRATION, resource_name),
            )
            row = cursor.fetchone()
            return row["watermark_value"] if row else None

    def _start_run(self, resource_name: str) -> UUID:
        with self._connection() as conn, conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO ops.integration_sync_run (integration_name, resource_name, status) VALUES (%s, %s, 'running') RETURNING id",
                (INTEGRATION, resource_name),
            )
            run_id = cursor.fetchone()["id"]
            conn.commit()
            return run_id

    def _finish_run(self, run_id: UUID, status: str, result: PullResult, watermark: str | None, error: str | None = None) -> None:
        with self._connection() as conn, conn.cursor() as cursor:
            note = error or result.message
            if result.scope:
                scope = "bounded pull " + json.dumps(result.scope, sort_keys=True, default=str)
                note = f"{note}; {scope}" if note else scope
            cursor.execute(
                """
                UPDATE ops.integration_sync_run
                SET status = %s, completed_at = now(), records_fetched = %s, records_inserted = %s, error_message = %s
                WHERE id = %s
                """,
                (status, result.fetched, result.inserted, note[:1000] if note else None, run_id),
            )
            if status == "succeeded" and watermark:
                cursor.execute(
                    """
                    INSERT INTO ops.source_watermark (integration_name, resource_name, watermark_value, updated_at)
                    SELECT %s, resource_name, %s, now() FROM ops.integration_sync_run WHERE id = %s
                    ON CONFLICT (integration_name, resource_name)
                    DO UPDATE SET watermark_value = excluded.watermark_value, updated_at = excluded.updated_at
                    """,
                    (INTEGRATION, watermark, run_id),
                )
            conn.commit()

    def _annotate_run(self, run_id: UUID, note: str) -> None:
        with self._connection() as conn, conn.cursor() as cursor:
            cursor.execute("UPDATE ops.integration_sync_run SET error_message = %s WHERE id = %s", (note[:1000], run_id))
            conn.commit()


winteam = WinTeamIngestion()
