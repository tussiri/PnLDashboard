"""Connector behaviour against the documented envelopes; HTTP is faked with httpx.MockTransport."""
from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import date, timedelta

import httpx
import pytest

from app.winteam import (
    RESOURCES,
    WinTeamClient,
    WinTeamError,
    date_windows,
    error_message,
    fiscal_years,
    flatten_gl_budget,
    id_ap_invoices,
    id_ar_invoices,
    id_gl_budgets,
    id_jobs,
    months_before,
    parse_data_array,
    parse_paged,
    rfc3339_end,
    rfc3339_start,
    window_start,
)

TENANT_ERROR = {
    "errors": [{"attemptedValue": "MalformedTenant", "fieldName": "TenantId", "errorMessage": "TenantId must be a GUID."}],
    "success": False,
    "serverResponse": "Operation failed! See the Errors for more information.",
}


def paged(results: list[dict], page: int = 1, total_pages: int = 1, total_count: int | None = None) -> dict:
    return {
        "data": [{"pageNumber": page, "pageSize": len(results), "totalPages": total_pages, "totalCount": total_count if total_count is not None else len(results), "results": results}],
        "success": True,
        "serverResponse": "OK.",
    }


# ── envelopes ────────────────────────────────────────────────────────────────
def test_parse_paged_documented_sample() -> None:
    page = parse_paged(paged([{"timekeepingId": 12345, "employeeNumber": 65, "jobNumber": "10002B"}], total_pages=3, total_count=250))
    assert page.page_number == 1
    assert page.total_pages == 3
    assert page.total_count == 250
    assert page.results[0]["timekeepingId"] == 12345


def test_parse_paged_no_content_and_empty_data() -> None:
    assert parse_paged(None).results == []
    assert parse_paged({"data": [], "success": True}).results == []
    assert parse_paged({"data": None, "success": True}).total_pages == 1


def test_parse_paged_surfaces_field_errors() -> None:
    with pytest.raises(WinTeamError, match="TenantId must be a GUID"):
        parse_paged(TENANT_ERROR)


def test_error_message_includes_status_and_fields() -> None:
    message = error_message(422, TENANT_ERROR)
    assert message.startswith("WinTeam returned HTTP 422")
    assert "TenantId: TenantId must be a GUID." in message
    assert "MalformedTenant" in message
    assert error_message(500, {"success": False, "serverResponse": "Oops, something went wrong."}).endswith("Oops, something went wrong.")
    assert error_message(503, None) == "WinTeam returned HTTP 503"


def test_gl_budget_flattening() -> None:
    payload = {
        "data": [
            {
                "jobNumber": "40035N",
                "fiscalYear": 2021,
                "glBudgetId": 1668,
                "glBudgetDetails": [
                    {"id": 5390, "glAccountNumber": 3010, "glAccountDescription": "Service Income", "budgetTotal": 130, "period1": 10, "period2": 120},
                    {"id": 5391, "glAccountNumber": 5010, "glAccountDescription": "Wages", "budgetTotal": 50},
                ],
            }
        ],
        "success": True,
        "serverResponse": "OK.",
    }
    records = [record for entry in parse_data_array(payload) for record in flatten_gl_budget(entry)]
    assert len(records) == 2
    assert records[0]["jobNumber"] == "40035N"
    assert records[0]["fiscalYear"] == 2021
    assert records[0]["glBudgetId"] == 1668
    assert records[0]["period2"] == 120
    assert id_gl_budgets(records[1]) == "40035N:2021:5391"
    assert parse_data_array(None) == []


# ── record ids ───────────────────────────────────────────────────────────────
def test_record_ids_follow_the_documented_keys() -> None:
    assert id_jobs({"jobId": "74de9508-bd76-4fb3-9d29-2aafe8719ee9", "jobNumber": "10002z"}) == "74de9508-bd76-4fb3-9d29-2aafe8719ee9"
    assert id_jobs({"jobId": None, "jobNumber": "10002z"}) == "10002z"
    assert id_ap_invoices({"companyNumber": 1, "vendorNumber": 1000, "invoiceNumber": "Monthly-080101"}) == "1:1000:Monthly-080101"
    assert id_ar_invoices({"customerNumber": 342, "invoiceNumber": 1}) == "342:1"
    assert RESOURCES["timekeeping"].record_id({"timekeepingId": 12345}) == "12345"
    assert RESOURCES["job_schedules"].record_id({"id": 84868}) == "84868"
    assert RESOURCES["ap_payments"].record_id({"paymentId": 2}) == "2"
    assert RESOURCES["vendors"].record_id({"vendorNumber": 2}) == "2"


def test_missing_record_id_is_an_error() -> None:
    with pytest.raises(WinTeamError, match="timekeepingId"):
        RESOURCES["timekeeping"].record_id({"employeeNumber": 65})
    with pytest.raises(WinTeamError, match="jobNumber"):
        id_jobs({"jobId": "", "jobNumber": None})


def test_catalogue_matches_documentation() -> None:
    assert RESOURCES["timekeeping"].path == "/timekeeping/v2/api/timekeeping"
    assert RESOURCES["timekeeping"].date_params == ("dateFrom", "dateTo")
    assert RESOURCES["ap_payments"].date_params == ("startDate", "endDate")
    assert RESOURCES["gl_budgets"].path == "/jobs/v2/api/jobs/{jobKey}/gl-budgets"
    assert RESOURCES["gl_budgets"].envelope == "data_array"
    assert RESOURCES["ar_invoices"].kind == "per_customer"
    assert RESOURCES["job_schedules"].kind == "per_job_date_window"
    assert RESOURCES["ap_invoice_details"].path == "/accounts/v1/api/payables/invoices/{invoiceNumber}"
    assert RESOURCES["ap_invoice_details"].kind == "per_invoice"
    assert RESOURCES["ap_invoice_details"].envelope == "data_array"
    assert RESOURCES["job_budgets"].path == "/jobs/v2/api/jobs/{jobKey}/budgets"
    assert RESOURCES["job_budgets"].kind == "per_job"
    assert list(RESOURCES) == ["jobs", "vendors", "timekeeping", "job_schedules", "gl_budgets",
                               "job_budgets", "ap_invoices", "ap_invoice_details", "ar_invoices",
                               "ap_payments"]


# ── windows and watermarks ───────────────────────────────────────────────────
def test_date_windows_are_contiguous_and_bounded() -> None:
    windows = date_windows(date(2026, 1, 1), date(2026, 2, 5), 16)
    assert windows[0] == (date(2026, 1, 1), date(2026, 1, 16))
    assert windows[1] == (date(2026, 1, 17), date(2026, 2, 1))
    assert windows[-1] == (date(2026, 2, 2), date(2026, 2, 5))
    for (_, stop), (next_start, _) in zip(windows, windows[1:]):
        assert (next_start - stop).days == 1
    assert date_windows(date(2026, 3, 1), date(2026, 3, 1), 16) == [(date(2026, 3, 1), date(2026, 3, 1))]
    assert date_windows(date(2026, 3, 2), date(2026, 3, 1), 16) == []


def test_window_start_uses_backfill_then_lookback() -> None:
    today = date(2026, 9, 1)
    assert window_start(None, today, 18, 35) == date(2025, 3, 1)
    assert window_start("2026-08-20", today, 18, 35) == date(2026, 7, 16)
    assert window_start("2026-09-01", today, 18, 0) == today
    assert window_start("not-a-date", today, 18, 35) == date(2025, 3, 1)
    assert months_before(date(2026, 1, 31), 1) == date(2025, 12, 1)


def test_rfc3339_formatting() -> None:
    assert rfc3339_start(date(2026, 8, 1)) == "2026-08-01T00:00:00Z"
    assert rfc3339_end(date(2026, 8, 16)) == "2026-08-16T23:59:59Z"
    assert fiscal_years(date(2026, 9, 1), 2) == [2026, 2025]


# ── HTTP client ──────────────────────────────────────────────────────────────
def make_client(handler, **kwargs) -> tuple[WinTeamClient, list[float]]:
    sleeps: list[float] = []
    client = WinTeamClient(
        base_url="https://api.example.test/wtnextgen",
        headers={"tenantId": "11111111-2222-3333-4444-555555555555", "Ocp-Apim-Subscription-Key": "secret"},
        timeout=5,
        max_retries=kwargs.pop("max_retries", 2),
        page_size=kwargs.pop("page_size", 2),
        max_pages=kwargs.pop("max_pages", 50),
        transport=httpx.MockTransport(handler),
        sleep=sleeps.append,
    )
    return client, sleeps


def test_pagination_stops_at_total_pages_and_sends_headers() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        page = int(request.url.params["pageNumber"])
        return httpx.Response(200, json=paged([{"timekeepingId": page * 10}, {"timekeepingId": page * 10 + 1}], page=page, total_pages=3, total_count=6))

    client, _ = make_client(handler)
    pages = list(client.iter_pages(RESOURCES["timekeeping"].path, {"dateFrom": "2026-08-01T00:00:00Z", "dateTo": "2026-08-16T23:59:59Z"}))
    assert [p.page_number for p in pages] == [1, 2, 3]
    assert len(seen) == 3
    assert seen[0].headers["tenantId"] == "11111111-2222-3333-4444-555555555555"
    assert seen[0].headers["Ocp-Apim-Subscription-Key"] == "secret"
    assert seen[0].url.params["pageSize"] == "2"
    assert seen[0].url.params["dateFrom"] == "2026-08-01T00:00:00Z"
    assert seen[-1].url.params["pageNumber"] == "3"


def test_pagination_stops_on_empty_results_and_204() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        page = int(request.url.params["pageNumber"])
        if page == 1:
            return httpx.Response(200, json=paged([{"vendorNumber": 1}], page=1, total_pages=99))
        return httpx.Response(200, json=paged([], page=page, total_pages=99))

    client, _ = make_client(handler)
    pages = list(client.iter_pages(RESOURCES["vendors"].path))
    assert [len(p.results) for p in pages] == [1, 0]
    assert calls == 2

    client, _ = make_client(lambda request: httpx.Response(204))
    assert client.get("/jobs/v2/api/jobs") is None
    assert [p.results for p in client.iter_pages("/jobs/v2/api/jobs")] == [[]]


def test_max_pages_guard() -> None:
    client, _ = make_client(lambda request: httpx.Response(200, json=paged([{"vendorNumber": 1}], page=int(request.url.params["pageNumber"]), total_pages=10)), max_pages=3)
    with pytest.raises(WinTeamError, match="WINTEAM_MAX_PAGES_PER_SYNC"):
        list(client.iter_pages(RESOURCES["vendors"].path))


def test_retry_on_429_honours_retry_after() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, headers={"Retry-After": "3"}, json={"success": False, "serverResponse": "Rate limit"})
        if attempts == 2:
            return httpx.Response(503)
        return httpx.Response(200, json=paged([{"jobNumber": "10002z"}]))

    client, sleeps = make_client(handler, max_retries=3)
    page = parse_paged(client.get("/jobs/v2/api/jobs"))
    assert page.results[0]["jobNumber"] == "10002z"
    assert attempts == 3
    assert sleeps[0] == 3.0
    assert sleeps[1] == 1.0  # exponential backoff 0.5 * 2**1


def test_retries_are_bounded() -> None:
    client, sleeps = make_client(lambda request: httpx.Response(500, json={"success": False, "serverResponse": "Oops, something went wrong."}), max_retries=2)
    with pytest.raises(WinTeamError, match="HTTP 500") as excinfo:
        client.get("/jobs/v2/api/jobs")
    assert excinfo.value.status_code == 500
    assert len(sleeps) == 2


def test_transport_errors_are_retried_then_raised() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    client, sleeps = make_client(handler, max_retries=1)
    with pytest.raises(WinTeamError, match="ConnectTimeout"):
        client.get("/jobs/v2/api/jobs")
    assert len(sleeps) == 1


def test_validation_errors_are_not_retried() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(400, json=TENANT_ERROR)

    client, sleeps = make_client(handler)
    with pytest.raises(WinTeamError, match="TenantId must be a GUID") as excinfo:
        client.get("/jobs/v2/api/jobs")
    assert attempts == 1
    assert sleeps == []
    assert excinfo.value.status_code == 400
    assert excinfo.value.errors[0]["fieldName"] == "TenantId"


def test_non_json_body_is_an_error() -> None:
    client, _ = make_client(lambda request: httpx.Response(200, content=b"<html>gateway</html>"))
    with pytest.raises(WinTeamError, match="non-JSON"):
        client.get("/jobs/v2/api/jobs")


def test_query_parameters_are_encoded_as_documented() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=json.loads(json.dumps(paged([]))))

    client, _ = make_client(handler)
    list(client.iter_pages("/accounts/v1/api/receivables/invoices/", {"customerNumber": "342"}))
    assert seen[0].url.path == "/wtnextgen/accounts/v1/api/receivables/invoices/"
    assert seen[0].url.params["customerNumber"] == "342"


# ── entitlements, GL "no budget", customer numbers (pure) ────────────────────
from app.winteam import (  # noqa: E402
    NOT_ENTITLED,
    WinTeamIngestion,
    entitlement_from_run,
    is_no_gl_budget,
    merge_customer_numbers,
)
from app.config import Settings  # noqa: E402

GL_NO_BUDGET = {
    "errors": [{"attemptedValue": None, "fieldName": "JobKey", "errorMessage": "Invalid Job Number and Fiscal Year combination."}],
    "success": False,
    "serverResponse": "Operation failed! See the Errors for more information.",
}


def test_gl_budget_missing_is_not_a_failure() -> None:
    assert is_no_gl_budget(WinTeamError("nope", status_code=404)) is True
    err = WinTeamError(error_message(400, GL_NO_BUDGET), status_code=400, errors=GL_NO_BUDGET["errors"])
    assert is_no_gl_budget(err) is True
    assert is_no_gl_budget(WinTeamError(error_message(400, TENANT_ERROR), status_code=400, errors=TENANT_ERROR["errors"])) is False
    assert is_no_gl_budget(WinTeamError("forbidden", status_code=403)) is False
    assert is_no_gl_budget(RuntimeError("x")) is False


def test_entitlement_from_latest_run() -> None:
    assert entitlement_from_run(None) is None
    assert entitlement_from_run({"status": "succeeded", "error_message": None}) is True
    assert entitlement_from_run({"status": "failed", "error_message": f"{NOT_ENTITLED}: HTTP 403; WinTeam returned HTTP 403"}) is False
    assert entitlement_from_run({"status": "failed", "error_message": "WinTeam returned HTTP 500"}) is True


def test_customer_numbers_union_keeps_strings_unchanged() -> None:
    merged = merge_customer_numbers(["342", " AMAZ01 "], ["AIRG01", "AMAZ01", "0042", "", None])
    assert merged == ["342", "AMAZ01", "AIRG01", "0042"]


# ── ingestion against a fake warehouse ───────────────────────────────────────
class FakeCursor:
    def __init__(self, conn: "FakeConn") -> None:
        self.conn = conn
        self.rowcount = 1
        self._rows: list[dict] = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params=None) -> None:
        self.conn.statements.append((sql, params))
        text = " ".join(sql.split()).lower()
        self._rows = []
        if "insert into ops.integration_sync_run" in text:
            import uuid

            self._rows = [{"id": uuid.uuid4()}]
        elif "select customer_number from core.dim_customer" in text:
            self._rows = [{"customer_number": n} for n in self.conn.customers]
        elif "select job_number from core.dim_job" in text:
            self._rows = [{"job_number": n} for n in self.conn.jobs]
        elif "select max(completed_at) as at" in text:
            self._rows = [{"at": self.conn.last_success}]
        elif "select a.invoice_number from core.fact_ap_invoice a" in text:
            self._rows = [{"invoice_number": n} for n in self.conn.invoices]
        elif "select distinct on (resource_name)" in text:
            self._rows = list(self.conn.latest_runs)
        elif "select watermark_value" in text:
            self._rows = [{"watermark_value": self.conn.watermark}] if self.conn.watermark else []
        elif "select resource_name, watermark_value" in text:
            self._rows = []
        elif "insert into raw.winteam_record" in text:
            self.conn.landed.append(params)
        elif "update ops.integration_sync_run" in text:
            self.conn.finished.append(params)
        elif "insert into ops.source_watermark" in text:
            self.conn.watermarks_written.append(params)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConn:
    """Stands in for an autocommit psycopg connection: only `transaction()` opens one."""

    def __init__(self, customers=(), jobs=(), latest_runs=(), watermark=None, last_success=None, invoices=()) -> None:
        self.last_success = last_success
        self.invoices = list(invoices)
        self.customers = list(customers)
        self.jobs = list(jobs)
        self.latest_runs = list(latest_runs)
        self.watermark = watermark
        self.statements: list[tuple[str, object]] = []
        self.landed: list = []
        self.finished: list = []
        self.watermarks_written: list = []
        self.in_transaction = False

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    @contextmanager
    def transaction(self):
        self.in_transaction = True
        try:
            yield self
        finally:
            self.in_transaction = False

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None


ENABLED_ENV = {
    "WINTEAM_ENABLED": "true",
    "WINTEAM_BASE_URL": "https://api.example.test/wtnextgen",
    "WINTEAM_TENANT_ID": "11111111-2222-3333-4444-555555555555",
    "WINTEAM_MAX_RETRIES": "0",
    "WINTEAM_WINDOW_DAYS": "366",
}


def ingestion(monkeypatch, handler, conn: FakeConn, env: dict | None = None) -> WinTeamIngestion:
    import app.winteam as module

    @contextmanager
    def fake_connection(**_kwargs):
        yield conn

    monkeypatch.setattr(module, "connection", fake_connection)
    ing = WinTeamIngestion(Settings.load({**ENABLED_ENV, **(env or {})}))
    monkeypatch.setattr(ing, "_client", lambda: make_client(handler, max_retries=0)[0])
    return ing


def test_403_marks_resource_not_entitled_and_sync_all_continues(monkeypatch) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if "/schedules" in request.url.path or "/payables/payments" in request.url.path:
            return httpx.Response(403, json={"statusCode": 403, "message": "Forbidden"})
        return httpx.Response(200, json=paged([{"jobId": "g-1", "jobNumber": "100"}]) if "/jobs/v2/api/jobs" in request.url.path else paged([{"vendorNumber": 7}]))

    conn = FakeConn(jobs=["100"])
    ing = ingestion(monkeypatch, handler, conn, {"WINTEAM_RESOURCES": "jobs,job_schedules,vendors,ap_payments"})
    outcome = ing.sync_all(normalize=False)
    by_name = {run["resource"]: run for run in outcome["runs"]}
    assert [run["resource"] for run in outcome["runs"]] == ["jobs", "vendors", "job_schedules", "ap_payments"]
    assert by_name["job_schedules"]["status"] == "failed"
    assert by_name["job_schedules"]["entitled"] is False
    assert by_name["job_schedules"]["error"] == f"{NOT_ENTITLED}: HTTP 403"
    assert by_name["ap_payments"]["entitled"] is False
    assert by_name["jobs"]["status"] == "succeeded" and by_name["jobs"]["entitled"] is True
    assert by_name["vendors"]["status"] == "succeeded"
    assert outcome["not_entitled"] == ["job_schedules", "ap_payments"]
    assert outcome["marts"] is None and outcome["normalized"] is False
    # the run row carries the not_entitled marker first, so status() can read it back
    failed_rows = [p for p in conn.finished if p[0] == "failed"]
    assert all(str(p[3]).startswith(f"{NOT_ENTITLED}: HTTP 403") for p in failed_rows)
    # raw landing happened for the entitled resources only
    assert {p[1] for p in conn.landed} == {"jobs", "vendors"}


def test_status_reports_entitlement_and_normalize_flag(monkeypatch) -> None:
    runs = [
        {"resource_name": "job_schedules", "status": "failed", "completed_at": None, "records_fetched": 0, "error_message": f"{NOT_ENTITLED}: HTTP 403"},
        {"resource_name": "jobs", "status": "succeeded", "completed_at": None, "records_fetched": 643, "error_message": None},
    ]
    conn = FakeConn(latest_runs=runs)
    ing = ingestion(monkeypatch, lambda request: httpx.Response(204), conn, {"WINTEAM_NORMALIZE": "false"})
    status = ing.status()
    by_name = {r["name"]: r for r in status["resources"]}
    assert by_name["job_schedules"]["entitled"] is False
    assert by_name["jobs"]["entitled"] is True
    assert by_name["vendors"]["entitled"] is None
    assert status["normalize_enabled"] is False


def test_gl_budget_400_without_budget_is_skipped(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/jobs/A1/gl-budgets"):
            return httpx.Response(400, json=GL_NO_BUDGET)
        if request.url.path.endswith("/jobs/A2/gl-budgets"):
            return httpx.Response(404)
        return httpx.Response(
            200,
            json={"data": [{"jobNumber": "A3", "fiscalYear": int(request.url.params["fiscalYear"]), "glBudgetId": 1, "glBudgetDetails": [{"id": 9, "glAccountNumber": 3010, "budgetTotal": 12}]}], "success": True},
        )

    conn = FakeConn(jobs=["A1", "A2", "A3", "A4"])
    ing = ingestion(monkeypatch, handler, conn, {"WINTEAM_GL_FISCAL_YEARS": "1"})
    result = ing.sync("gl_budgets", normalize=False, jobs_limit=3)
    assert result["status"] == "succeeded"
    assert result["fetched"] == 1 and result["scope"] == {"jobs_limit": 3}
    assert "2 job-year(s) without a budget" in result["message"]
    assert conn.watermarks_written == []  # bounded pulls never advance the watermark


def test_receivables_customer_numbers_are_the_union_and_pass_through(monkeypatch) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params["customerNumber"])
        return httpx.Response(204)

    conn = FakeConn(customers=["AIRG01", "AMAZ01", "0042"])
    ing = ingestion(monkeypatch, handler, conn, {"WINTEAM_CUSTOMER_NUMBERS": "342, AMAZ01"})
    result = ing.sync("ar_invoices", normalize=False)
    assert result["status"] == "succeeded"
    assert seen == ["342", "AMAZ01", "AIRG01", "0042"]
    inserted = [p for sql, p in conn.statements if "insert into core.dim_customer" in " ".join(sql.split()).lower()]
    assert inserted == [(["342", "AMAZ01"],)]

    seen.clear()
    result = ing.sync("ar_invoices", normalize=False, customer_numbers=["AIRG01", "AMAZ01", "AIRG01"])
    assert seen == ["AIRG01", "AMAZ01"]
    assert result["scope"] == {"customer_numbers": ["AIRG01", "AMAZ01"]}


def test_start_date_override_bounds_the_window_and_skips_normalization(monkeypatch) -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        return httpx.Response(200, json=paged([{"timekeepingId": 1, "employeeNumber": "65", "jobNumber": "100", "workDate": "2026-08-25T12:00:00Z", "hours": 8}]))

    conn = FakeConn()
    ing = ingestion(monkeypatch, handler, conn)
    normalized: list[str] = []
    monkeypatch.setattr(ing, "_normalize", lambda resource, result, run_id: normalized.append(resource.name) or 1)
    result = ing.sync("timekeeping", normalize=False, start_date=date.today() - timedelta(days=14))
    assert result["status"] == "succeeded" and result["fetched"] == 1
    assert seen[0]["dateFrom"] == rfc3339_start(date.today() - timedelta(days=14))
    assert result["normalized"] is None and normalized == []
    assert conn.watermarks_written == []
    # normalization is invoked when asked for
    ing.sync("timekeeping", normalize=True)
    assert normalized == ["timekeeping"]


def test_sync_all_honours_the_config_normalize_flag(monkeypatch) -> None:
    conn = FakeConn()
    ing = ingestion(monkeypatch, lambda request: httpx.Response(204), conn, {"WINTEAM_NORMALIZE": "false", "WINTEAM_RESOURCES": "vendors"})
    called: list[str] = []
    monkeypatch.setattr(ing, "_normalize", lambda resource, result, run_id: called.append(resource.name) or 0)
    outcome = ing.sync_all()
    assert outcome["normalized"] is False and outcome["marts"] is None and called == []
    with pytest.raises(WinTeamError, match="Unknown resource"):
        ing.sync_all(resources=["nope"])


def test_receivables_records_get_the_queried_customer_number(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        # the live tenant omits customerNumber inside each record
        return httpx.Response(200, json=paged([{"invoiceNumber": 160334, "invoiceTotal": 10}, {"invoiceNumber": 160335, "customerNumber": "OTHER"}]))

    conn = FakeConn()
    ing = ingestion(monkeypatch, handler, conn)
    result = ing.sync("ar_invoices", normalize=False, customer_numbers=["AMAZ01"])
    assert result["status"] == "succeeded" and result["fetched"] == 2
    assert [p[2] for p in conn.landed] == ["AMAZ01:160334", "OTHER:160335"]
    assert json.loads(conn.landed[0][4])["customerNumber"] == "AMAZ01"


# ── no transaction may span a WinTeam fetch (the 2026-09-09 worker stall) ────
def test_no_open_transaction_while_fetching(monkeypatch) -> None:
    """A pull must never leave the session `idle in transaction` across an HTTP call.

    Holding one open across the fetches kept ACCESS SHARE on core.dim_job for the whole pull,
    which queued the mart rebuild's TRUNCATE and, behind it, every reporting read.
    """
    open_during_fetch: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if conn.in_transaction:
            open_during_fetch.append(request.url.path)
        if request.url.path.endswith("/gl-budgets"):
            return httpx.Response(200, json={"data": [{
                "jobNumber": "100", "fiscalYear": 2026, "glBudgetId": 5,
                "glBudgetDetails": [{"id": 9, "glNumber": "4000", "annualAmount": 12}],
            }]})
        if "/receivables/invoices" in request.url.path:
            return httpx.Response(200, json=paged([{"invoiceNumber": 160334, "invoiceTotal": 10}]))
        return httpx.Response(200, json=paged([{"jobId": "g-1", "jobNumber": "100"}]))

    conn = FakeConn(jobs=["100", "200"], customers=["AMAZ01"])
    ing = ingestion(
        monkeypatch, handler, conn,
        {"WINTEAM_RESOURCES": "jobs,gl_budgets,ar_invoices", "WINTEAM_GL_FISCAL_YEARS": "1"},
    )
    outcome = ing.sync_all(normalize=False)
    assert [run["status"] for run in outcome["runs"]] == ["succeeded"] * 3
    assert conn.landed, "the pull must still have landed rows"
    assert open_during_fetch == []
    assert conn.in_transaction is False


def test_land_writes_its_batch_in_one_transaction(monkeypatch) -> None:
    """The batch is atomic even though the session is in autocommit."""
    from app.winteam import PullResult
    from uuid import uuid4

    conn = FakeConn()
    inside: list[bool] = []

    class Recorder(FakeCursor):
        def execute(self, sql: str, params=None) -> None:
            inside.append(self.conn.in_transaction)
            super().execute(sql, params)

    monkeypatch.setattr(FakeConn, "cursor", lambda self: Recorder(self))
    ing = WinTeamIngestion(Settings.load(ENABLED_ENV))
    result = PullResult()
    ing._land(conn, uuid4(), RESOURCES["vendors"], [{"vendorNumber": 1}, {"vendorNumber": 2}], result)
    assert inside == [True, True] and result.fetched == 2
    assert conn.in_transaction is False


# ── AP GL distributions ──────────────────────────────────────────────────────
def test_flatten_ap_distribution_carries_the_header_onto_every_line() -> None:
    """The list endpoint returns headers alone; only this per-invoice shape attributes cost to a job."""
    from app.winteam import flatten_ap_distribution

    lines = flatten_ap_distribution({
        "invoiceNumber": "9010236526", "vendorNumber": 1033, "companyNumber": 3,
        "invoiceDate": "2026-09-17", "postingDate": "2026-09-17", "invoiceAmount": 906.21,
        "generalLedgerDistributions": [
            {"accountNumber": 40902, "jobNumber": "900", "amount": 906.21},
            {"accountNumber": 41000, "jobNumber": "901", "amount": 0},
        ],
    })
    assert [l["lineIndex"] for l in lines] == [0, 1]
    assert [l["jobNumber"] for l in lines] == ["900", "901"]
    assert all(l["invoiceNumber"] == "9010236526" and l["vendorNumber"] == 1033 for l in lines)
    assert all(l["invoiceDate"] == "2026-09-17" for l in lines)


def test_flatten_ap_distribution_yields_nothing_without_distributions() -> None:
    from app.winteam import flatten_ap_distribution

    assert flatten_ap_distribution({"invoiceNumber": "X", "generalLedgerDistributions": []}) == []
    assert flatten_ap_distribution({"invoiceNumber": "X"}) == []
    assert flatten_ap_distribution({"invoiceNumber": "X", "generalLedgerDistributions": "nope"}) == []


def test_distribution_identity_separates_repeated_job_and_account() -> None:
    """One invoice may code the same job and account twice; the line position is what disambiguates."""
    from app.winteam import id_ap_distributions

    base = {"companyNumber": 3, "vendorNumber": 1033, "invoiceNumber": "9010236526",
            "accountNumber": 40902, "jobNumber": "900"}
    assert id_ap_distributions({**base, "lineIndex": 0}) != id_ap_distributions({**base, "lineIndex": 1})
    assert id_ap_distributions({**base, "lineIndex": 0}) == "3:1033:9010236526:0"


def test_ap_detail_outage_threshold_is_defined_and_small() -> None:
    """Scattered per-invoice failures are skipped; an unbroken run of them is an outage. The
    threshold is what separates the two, and a 7,000-invoice backfill must not die on one bad
    invoice (1384 answered HTTP 500 on all four attempts)."""
    from app.winteam import AP_DETAIL_MAX_CONSECUTIVE_ERRORS

    assert 5 <= AP_DETAIL_MAX_CONSECUTIVE_ERRORS <= 100


# ── job budgets ──────────────────────────────────────────────────────────────
def test_flatten_job_budget_spreads_hours_across_the_week() -> None:
    """Budget is hours PER DAY OF WEEK plus a rate, which apportions to a week without proration."""
    from app.winteam import flatten_job_budget, id_job_budgets

    lines = flatten_job_budget({
        "id": 119, "effectiveDate": "2026-01-01T00:00:00", "endDate": "2026-12-31T00:00:00",
        "status": "Posted - Cannot Edit",
        "details": [{
            "hours": {"description": "Ops/Regular", "type": 15, "salaried": False,
                      "dayOfWeek": {"sun": 545.83, "mon": 545.83, "tue": 545.83, "wed": 545.83,
                                    "thu": 545.83, "fri": 545.83, "sat": 545.83, "hol": 545.83}},
            "rates": {"billRate": None, "payRate": 17.5},
        }],
    })
    assert len(lines) == 1
    line = lines[0]
    assert line["budgetId"] == 119 and line["lineIndex"] == 0
    assert line["payRate"] == 17.5 and line["billRate"] is None
    assert line["mon"] == 545.83 and line["hol"] == 545.83
    assert line["description"] == "Ops/Regular" and line["salaried"] is False
    line["jobNumber"] = "500"
    assert id_job_budgets(line) == "500:119:0"


def test_a_budget_with_no_detail_lines_yields_nothing() -> None:
    from app.winteam import flatten_job_budget

    assert flatten_job_budget({"id": 7, "details": []}) == []
    assert flatten_job_budget({"id": 7}) == []
    assert flatten_job_budget({"id": 7, "details": "nope"}) == []


def test_a_missing_day_stays_missing_rather_than_becoming_zero() -> None:
    """A budget that omits Saturday is not a budget of zero Saturday hours."""
    from app.winteam import flatten_job_budget

    line = flatten_job_budget({"id": 1, "details": [
        {"hours": {"dayOfWeek": {"mon": 8}}, "rates": {"payRate": 20}},
    ]})[0]
    assert line["mon"] == 8
    assert line["sat"] is None and line["hol"] is None


# ── on-demand syncs ask WinTeam for as little as possible ───────────────────
def test_server_errors_can_be_raised_without_retrying() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(500, json={"success": False, "serverResponse": "Oops"})

    client, sleeps = make_client(handler, max_retries=4)
    with pytest.raises(WinTeamError) as info:
        client.get("/accounts/v1/api/payables/invoices/6.12.26", retry_server_errors=False)
    assert info.value.status_code == 500 and len(calls) == 1 and sleeps == []


def test_rate_limits_are_still_honoured_without_server_retries() -> None:
    responses = iter([httpx.Response(429, headers={"Retry-After": "2"}), httpx.Response(200, json={"data": []})])
    client, sleeps = make_client(lambda request: next(responses), max_retries=2)
    assert client.get("/x", retry_server_errors=False) == {"data": []}
    assert sleeps == [2.0]


def test_daily_resources_are_skipped_when_synced_recently(monkeypatch) -> None:
    from datetime import datetime, timedelta, timezone

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json=paged([{"vendorNumber": 7}]))

    recent = datetime.now(timezone.utc) - timedelta(hours=2)
    conn = FakeConn(last_success=recent)
    ing = ingestion(monkeypatch, handler, conn, {"WINTEAM_RESOURCES": "vendors"})
    skipped = ing.sync("vendors", normalize=False)
    assert skipped["status"] == "skipped" and skipped["requests"] == 0 and calls == []
    outcome = ing.sync_all(normalize=True)
    assert outcome["runs"][0]["status"] == "skipped" and outcome["marts"] is None
    forced = ing.sync("vendors", normalize=False, force=True)
    assert forced["status"] == "succeeded" and len(calls) == 1
    conn.last_success = datetime.now(timezone.utc) - timedelta(hours=30)
    assert ing.sync("vendors", normalize=False)["status"] == "succeeded"


def test_timekeeping_is_never_daily_skipped(monkeypatch) -> None:
    from datetime import datetime, timezone

    conn = FakeConn(last_success=datetime.now(timezone.utc))
    ing = ingestion(monkeypatch, lambda request: httpx.Response(200, json=paged([])), conn, {"WINTEAM_RESOURCES": "timekeeping"})
    assert ing.sync("timekeeping", normalize=False)["status"] == "succeeded"


def test_lookback_is_short_unless_deep(monkeypatch) -> None:
    conn = FakeConn(watermark="2026-09-20")
    ing = ingestion(monkeypatch, lambda request: httpx.Response(204), conn, {"WINTEAM_WINDOW_DAYS": "366"})
    today = date(2026, 9, 22)
    assert ing._windows(RESOURCES["timekeeping"], today)[0][0] == date(2026, 9, 17)
    assert ing._windows(RESOURCES["timekeeping"], today, deep=True)[0][0] == date(2026, 8, 16)


def test_unretrievable_invoices_are_remembered_and_not_retried(monkeypatch) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/6.12.26"):
            return httpx.Response(500, json={"success": False, "serverResponse": "Oops"})
        if request.url.path.endswith("/A%2F1") or request.url.path.endswith("/A/1"):
            return httpx.Response(404)
        return httpx.Response(200, json={"data": [{"invoiceNumber": "900", "vendorNumber": 1, "generalLedgerDistributions": [
            {"lineIndex": 1, "accountNumber": "5000", "jobNumber": "100", "amount": 10}]}]})

    conn = FakeConn(invoices=["6.12.26", "A/1", "900"])
    ing = ingestion(monkeypatch, handler, conn, {"WINTEAM_RESOURCES": "ap_invoice_details", "WINTEAM_MAX_RETRIES": "4"})
    monkeypatch.setattr(ing, "_client", lambda: make_client(handler, max_retries=4)[0])
    run = ing.sync("ap_invoice_details", normalize=False)
    assert run["status"] == "succeeded"
    assert len(calls) == 3  # one request per invoice: the 500 is not retried
    remembered = [p for sql, p in conn.statements if "INSERT INTO ops.winteam_unretrievable" in sql]
    assert [(p[2], p[3]) for p in remembered] == [("6.12.26", 500), ("A/1", 404)]
    forgotten = [p for sql, p in conn.statements if "DELETE FROM ops.winteam_unretrievable" in sql]
    assert [p[2] for p in forgotten] == ["900"]
    query = next((" ".join(sql.split()), p) for sql, p in conn.statements if "SELECT a.invoice_number" in sql)
    assert "u.last_attempt_at > now() - %(recheck)s" in query[0] and query[1]["integration"] == "winteam"
