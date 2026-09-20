"""Contract tests: every simulated endpoint must match the shapes in WinTeamAPI.txt."""

from __future__ import annotations

import math
import re
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from sim.app import create_app
from sim.data import Dataset, SimConfig

TODAY = date(2026, 9, 1)
TENANT = "11111111-1111-4111-8111-111111111111"
HEADERS = {"tenantId": TENANT}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T12:00:00Z$")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
GUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def small_config(**overrides) -> SimConfig:
    base = dict(seed=7, jobs=14, months=8, today=TODAY, tenant_id=TENANT)
    base.update(overrides)
    return SimConfig(**base)


@pytest.fixture(scope="module")
def app():
    return create_app(small_config())


@pytest.fixture(scope="module")
def ds(app) -> Dataset:
    return app.state.dataset


@pytest.fixture(scope="module")
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture(scope="module")
def site_job(ds: Dataset):
    return next(j for j in ds.jobs if not j.is_parent and j.end is None and j.start < TODAY - timedelta(days=200))


@pytest.fixture(scope="module")
def parent_job(ds: Dataset):
    return next(j for j in ds.jobs if j.is_parent)


# --------------------------------------------------------------------------- helpers

def assert_paged_envelope(body: dict, page_number: int, page_size: int) -> list:
    assert set(body) == {"data", "success", "serverResponse"}
    assert body["success"] is True and body["serverResponse"] == "OK."
    assert isinstance(body["data"], list) and len(body["data"]) == 1
    page = body["data"][0]
    assert list(page) == ["pageNumber", "pageSize", "totalPages", "totalCount", "results"]
    assert page["pageNumber"] == page_number and page["pageSize"] == page_size
    assert page["totalPages"] == math.ceil(page["totalCount"] / page_size)
    assert 0 < len(page["results"]) <= page_size
    return page["results"]


def assert_error_envelope(body: dict, field: str, attempted):
    assert set(body) == {"errors", "success", "serverResponse"}
    assert body["success"] is False
    assert body["serverResponse"] == "Operation failed! See the Errors for more information."
    err = body["errors"][0]
    assert list(err) == ["attemptedValue", "fieldName", "errorMessage"]
    assert err["fieldName"] == field and err["attemptedValue"] == attempted


def collect_all(client: TestClient, path: str, params: dict, page_size: int) -> tuple[list, int]:
    rows, page = [], 1
    total = None
    while True:
        r = client.get(path, params={**params, "pageSize": page_size, "pageNumber": page}, headers=HEADERS)
        if r.status_code == 204:
            break
        assert r.status_code == 200
        p = r.json()["data"][0]
        total = p["totalCount"]
        rows.extend(p["results"])
        if len(p["results"]) < page_size:
            break
        page += 1
    return rows, total or 0


# --------------------------------------------------------------------------- tenant / auth

def test_missing_tenant_is_400(client):
    r = client.get("/jobs/v2/api/jobs")
    assert r.status_code == 400
    assert_error_envelope(r.json(), "TenantId", None)
    assert r.json()["errors"][0]["errorMessage"] == "TenantId must be a GUID."


def test_malformed_tenant_is_422(client):
    r = client.get("/jobs/v2/api/jobs", headers={"tenantId": "MalformedTenant"})
    assert r.status_code == 422
    assert_error_envelope(r.json(), "TenantId", "MalformedTenant")


def test_unknown_tenant_guid_is_401(client):
    r = client.get("/jobs/v2/api/jobs", headers={"tenantId": "22222222-2222-4222-8222-222222222222"})
    assert r.status_code == 401
    assert r.json()["success"] is False


def test_tenant_header_is_case_insensitive(client):
    r = client.get("/jobs/v2/api/jobs", headers={"TENANTID": TENANT})
    assert r.status_code == 200


def test_sim_endpoints_need_no_tenant(client):
    assert client.get("/__sim/health").json()["status"] == "ok"
    s = client.get("/__sim/summary").json()
    assert s["tenantId"] == TENANT
    assert s["customerNumbers"] == [str(1001 + i) for i in range(10)]
    assert s["counts"]["timekeeping"] > 0
    assert s["suggestedEnv"]["WINTEAM_CUSTOMER_NUMBERS"] == ",".join(s["customerNumbers"])


def test_subscription_key_enforced_when_configured():
    c = TestClient(create_app(small_config(jobs=4, months=2, subscription_key="secret-key")))
    r = c.get("/vendors/v1/api/vendors/", headers=HEADERS)
    assert r.status_code == 401 and "subscription key" in r.json()["message"]
    r = c.get("/vendors/v1/api/vendors/", headers={**HEADERS, "Ocp-Apim-Subscription-Key": "wrong"})
    assert r.status_code == 401
    r = c.get("/vendors/v1/api/vendors/", headers={**HEADERS, "Ocp-Apim-Subscription-Key": "secret-key"})
    assert r.status_code == 200


def test_rate_limit_chaos():
    c = TestClient(create_app(small_config(jobs=4, months=2, rate_limit_every=3)))
    codes = [c.get("/vendors/v1/api/vendors", headers=HEADERS).status_code for _ in range(6)]
    assert codes == [200, 200, 429, 200, 200, 429]
    r = c.get("/vendors/v1/api/vendors", headers=HEADERS)  # 7th
    assert r.status_code == 200
    r = c.get("/vendors/v1/api/vendors", headers=HEADERS)
    assert r.status_code == 200
    r = c.get("/vendors/v1/api/vendors", headers=HEADERS)  # 9th
    assert r.status_code == 429 and r.headers["Retry-After"] == "1"


# --------------------------------------------------------------------------- timekeeping

TK_KEYS = ["timekeepingId", "employeeNumber", "jobNumber", "workDate", "hours", "categoryDetailId", "inTime",
           "outTime", "lunch", "rate", "workTicketNumber"]


def test_timekeeping_shape(client):
    r = client.get("/timekeeping/v2/api/timekeeping",
                   params={"dateFrom": "2026-08-01T00:00:00Z", "dateTo": "2026-08-07T00:00:00Z"}, headers=HEADERS)
    assert r.status_code == 200
    rows = assert_paged_envelope(r.json(), 1, 100)
    for row in rows:
        assert list(row) == TK_KEYS
        assert isinstance(row["timekeepingId"], int)
        assert isinstance(row["employeeNumber"], str) and row["employeeNumber"].isdigit()
        assert isinstance(row["jobNumber"], str)
        assert DATE_RE.match(row["workDate"]) and STAMP_RE.match(row["inTime"]) and STAMP_RE.match(row["outTime"])
        assert row["categoryDetailId"] in (1, 2)
        assert 0 < row["hours"] <= 10 and 15 <= row["rate"] <= 28
        assert "2026-08-01" <= row["workDate"][:10] <= "2026-08-07"


def test_timekeeping_requires_dates(client):
    r = client.get("/timekeeping/v2/api/timekeeping", params={"dateTo": "2026-08-07"}, headers=HEADERS)
    assert r.status_code == 400
    assert_error_envelope(r.json(), "DateFrom", None)
    r = client.get("/timekeeping/v2/api/timekeeping", params={"dateFrom": "not-a-date", "dateTo": "2026-08-07"},
                   headers=HEADERS)
    assert r.status_code == 422
    assert_error_envelope(r.json(), "DateFrom", "not-a-date")


def test_timekeeping_empty_range_is_204(client):
    r = client.get("/timekeeping/v2/api/timekeeping", params={"dateFrom": "2030-01-01", "dateTo": "2030-01-31"},
                   headers=HEADERS)
    assert r.status_code == 204 and r.content == b""


def test_timekeeping_paging_math_and_ordering(client, ds):
    params = {"dateFrom": "2026-08-10", "dateTo": "2026-08-16"}
    rows, total = collect_all(client, "/timekeeping/v2/api/timekeeping", params, 37)
    assert total == len(rows) == len(ds.timekeeping_between(date(2026, 8, 10), date(2026, 8, 16)))
    ids = [r["timekeepingId"] for r in rows]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)
    r = client.get("/timekeeping/v2/api/timekeeping", params={**params, "pageSize": 5, "pageNumber": 2},
                   headers=HEADERS)
    page = r.json()["data"][0]
    assert page["pageNumber"] == 2 and page["totalPages"] == math.ceil(total / 5)
    assert [x["timekeepingId"] for x in page["results"]] == ids[5:10]
    r = client.get("/timekeeping/v2/api/timekeeping", params={**params, "orderBy": "hours", "ascending": "false",
                                                             "pageSize": 1000}, headers=HEADERS)
    hours = [x["hours"] for x in r.json()["data"][0]["results"]]
    assert hours == sorted(hours, reverse=True)
    r = client.get("/timekeeping/v2/api/timekeeping", params={**params, "orderBy": "bogus"}, headers=HEADERS)
    assert r.status_code == 400 and r.json()["errors"][0]["fieldName"] == "OrderBy"


def test_timekeeping_page_size_is_capped(client):
    r = client.get("/timekeeping/v2/api/timekeeping",
                   params={"dateFrom": "2026-05-01", "dateTo": "2026-08-31", "pageSize": 5000}, headers=HEADERS)
    assert r.status_code == 200 and r.json()["data"][0]["pageSize"] == 1000


def test_timekeeping_has_overtime_and_consistent_times(client):
    r = client.get("/timekeeping/v2/api/timekeeping",
                   params={"dateFrom": "2026-06-01", "dateTo": "2026-08-31", "pageSize": 1000,
                           "orderBy": "categoryDetailId", "ascending": "false"}, headers=HEADERS)
    rows = r.json()["data"][0]["results"]
    assert rows[0]["categoryDetailId"] == 2, "expected some overtime rows"
    for row in rows[:200]:
        start = int(row["inTime"][11:13]) * 60 + int(row["inTime"][14:16])
        end = int(row["outTime"][11:13]) * 60 + int(row["outTime"][14:16])
        day_delta = (date.fromisoformat(row["outTime"][:10]) - date.fromisoformat(row["inTime"][:10])).days
        assert end + day_delta * 1440 - start == int((row["hours"] + row["lunch"]) * 60)


# --------------------------------------------------------------------------- jobs

JOB_KEYS = ["links", "jobJoinedDescription", "locationId", "companyNumber", "lighthouseApplication", "hoursRuleId",
            "jobAttention", "dateToStart", "typeId", "phone1", "phone1Description", "phone2", "phone2Description",
            "phone3", "phone3Description", "supervisorId", "taxesInsuranceId", "salesTaxStateId",
            "jobPayrollTaxStateId", "hoursCategoryID", "notes", "address", "taxAddress", "jobTiers", "customFields",
            "jobNumber", "parentJobNumber", "jobId", "jobDescription"]


def test_jobs_shape(client):
    r = client.get("/jobs/v2/api/jobs", headers=HEADERS)
    rows = assert_paged_envelope(r.json(), 1, 100)
    for job in rows:
        assert list(job) == JOB_KEYS
        assert list(job["address"]) == ["jobAddress1", "jobAddress2", "jobCity", "jobState", "jobZip"]
        assert list(job["taxAddress"]) == ["address1", "address2", "city", "state", "zip", "latitude", "longitude",
                                           "locationCode"]
        assert [t["tierID"] for t in job["jobTiers"]] == list(range(1, 13))
        assert all(list(t) == ["tierID", "tierValue", "tierValueDescription"] for t in job["jobTiers"])
        assert all(list(l) == ["rel", "href", "method"] for l in job["links"])
        assert all(list(c) == ["fieldNumber", "value"] for c in job["customFields"])
        assert GUID_RE.match(job["jobId"]) and DATE_RE.match(job["dateToStart"])
        assert job["jobJoinedDescription"] == f"{job['jobNumber']} {job['jobDescription']}"
        assert float(job["taxAddress"]["latitude"]) and float(job["taxAddress"]["longitude"])
    tiers = {t["tierID"]: t["tierValueDescription"] for t in rows[0]["jobTiers"]}
    assert tiers[1].endswith("Region") and tiers[4].startswith("Area ") and tiers[4].endswith("Manager")
    assert tiers[3] in {"Janitorial", "Industrial Services", "Healthcare EVS", "Education"}


def test_jobs_portfolio_shape(client, ds):
    rows = client.get("/jobs/v2/api/jobs", params={"pageSize": 1000}, headers=HEADERS).json()["data"][0]["results"]
    parents = [j for j in rows if j["parentJobNumber"] is None and j["typeId"] == 1]
    sites = [j for j in rows if j["typeId"] == 6]
    assert len(sites) == 14 and parents
    parent_numbers = {p["jobNumber"] for p in parents}
    assert all(j["parentJobNumber"] is None or j["parentJobNumber"] in parent_numbers for j in sites)
    assert any(j["taxAddress"]["state"] in {"ON", "BC", "AB", "QC"} for j in sites)
    assert len({j["jobId"] for j in rows}) == len(rows)
    summary = ds.summary()
    assert len(summary["recentJobs"]) == 2 and len(summary["inactiveJobs"]) == 2


def test_jobs_search_filter_order_and_204(client, ds, site_job):
    r = client.get("/jobs/v2/api/jobs", params={"searchFieldName": "jobNumber", "searchText": site_job.job_number,
                                               "exactMatch": "true"}, headers=HEADERS)
    rows = assert_paged_envelope(r.json(), 1, 100)
    assert len(rows) == 1 and rows[0]["jobId"] == site_job.job_id
    r = client.get("/jobs/v2/api/jobs", params={"searchFieldName": "jobDescription", "searchText": "ridgeline"},
                   headers=HEADERS)
    assert r.status_code == 200 and all("Ridgeline" in j["jobDescription"] for j in r.json()["data"][0]["results"])
    r = client.get("/jobs/v2/api/jobs", params={"locationId": site_job.location_id}, headers=HEADERS)
    assert all(j["locationId"] == site_job.location_id for j in r.json()["data"][0]["results"])
    r = client.get("/jobs/v2/api/jobs", params={"orderBy": "jobDescription", "ascending": "false"}, headers=HEADERS)
    descs = [j["jobDescription"].lower() for j in r.json()["data"][0]["results"]]
    assert descs == sorted(descs, reverse=True)
    r = client.get("/jobs/v2/api/jobs", params={"searchFieldName": "jobNumber", "searchText": "nope-nope"},
                   headers=HEADERS)
    assert r.status_code == 204
    r = client.get("/jobs/v2/api/jobs", params={"pageSize": 5, "pageNumber": 2}, headers=HEADERS)
    assert r.json()["data"][0]["totalCount"] == len(ds.jobs)


# --------------------------------------------------------------------------- gl budgets

GL_DETAIL_KEYS = ["id", "glAccountNumber", "glAccountDescription", "financialStatement", "jobCostAnalysis",
                  "budgetTotal"] + [f"period{i}" for i in range(1, 13)]


def test_gl_budgets_shape_and_keys(client, site_job):
    r = client.get(f"/jobs/v2/api/jobs/{site_job.job_number}/gl-budgets", params={"fiscalYear": 2025},
                   headers=HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"data", "success", "serverResponse"} and body["success"] is True
    assert isinstance(body["data"], list) and len(body["data"]) == 1
    entry = body["data"][0]
    assert list(entry) == ["jobNumber", "fiscalYear", "glBudgetId", "glBudgetDetails"]
    assert entry["jobNumber"] == site_job.job_number and entry["fiscalYear"] == 2025
    accounts = {d["glAccountNumber"]: d for d in entry["glBudgetDetails"]}
    assert {3010, 4010, 4200} <= set(accounts)
    assert accounts[3010]["glAccountDescription"] == "Service Income"
    for d in entry["glBudgetDetails"]:
        assert list(d) == GL_DETAIL_KEYS
        assert abs(d["budgetTotal"] - sum(d[f"period{i}"] for i in range(1, 13))) < 0.05


def test_gl_budgets_by_job_id_matches_job_number_and_defaults_to_current_year(client, site_job):
    a = client.get(f"/jobs/v2/api/jobs/{site_job.job_number}/gl-budgets", headers=HEADERS).json()
    b = client.get(f"/jobs/v2/api/jobs/{site_job.job_id.upper()}/gl-budgets", headers=HEADERS).json()
    assert a == b and a["data"][0]["fiscalYear"] == TODAY.year
    c = client.get(f"/jobs/v2/api/jobs/{site_job.job_number}/gl-budgets",
                   params={"jobCostAnalysis": "false"}, headers=HEADERS).json()
    assert all(d["financialStatement"] == 1 for d in c["data"][0]["glBudgetDetails"])


def test_gl_budgets_unknown_job_is_404(client):
    assert client.get("/jobs/v2/api/jobs/99999Z/gl-budgets", headers=HEADERS).status_code == 404


def test_post_budgets_echoes_body(client, site_job):
    payload = {"effectiveDate": "2021-01-01T12:00:00Z", "notes": "Some notes.", "details": [{
        "hours": {"description": "Day Custodian", "type": 1, "salaried": None,
                  "dayOfWeek": {"sun": None, "mon": 35, "tue": 35, "wed": 35, "thu": 35, "fri": 35, "sat": None,
                                "hol": None}},
        "rates": {"billRate": 10, "payRate": 6.5}}]}
    r = client.post(f"/jobs/v2/api/jobs/{site_job.job_number}/budgets", json=payload, headers=HEADERS)
    assert r.status_code == 201 and r.json() == payload
    r = client.post("/jobs/v2/api/jobs/nope/budgets", json=payload, headers=HEADERS)
    assert r.status_code == 404
    r = client.post(f"/jobs/v2/api/jobs/{site_job.job_number}/budgets", json={**payload, "effectiveDate": "x"},
                    headers=HEADERS)
    assert r.status_code == 422 and r.json()["errors"][0]["fieldName"] == "EffectiveDate"


# --------------------------------------------------------------------------- schedules

SCHED_KEYS = ["id", "scheduleDetailsID", "jobNumber", "employeeNumber", "jobPostDetailID", "workDate", "inTime",
              "outTime", "hours", "lunch"]


def test_schedules_shape_filter_and_paging(client, site_job):
    params = {"dateFrom": "2026-08-01T00:00:00Z", "dateTo": "2026-08-14T00:00:00Z"}
    r = client.get(f"/jobs/v2/api/jobs/{site_job.job_number}/schedules", params=params, headers=HEADERS)
    rows = assert_paged_envelope(r.json(), 1, 100)
    for row in rows:
        assert list(row) == SCHED_KEYS
        assert row["jobNumber"] == site_job.job_number and DATE_RE.match(row["workDate"])
        assert "2026-08-01" <= row["workDate"][:10] <= "2026-08-14"
        assert row["employeeNumber"] is None or isinstance(row["employeeNumber"], str)
    dates = {row["workDate"][:10] for row in rows}
    assert "2026-08-01" in dates and "2026-08-14" in dates, "date filter must be inclusive"
    all_rows, total = collect_all(client, f"/jobs/v2/api/jobs/{site_job.job_id}/schedules", params, 7)
    assert total == len(all_rows) and len({r["id"] for r in all_rows}) == total
    r = client.get(f"/jobs/v2/api/jobs/{site_job.job_number}/schedules", params={"dateFrom": "2026-08-01"},
                   headers=HEADERS)
    assert r.status_code == 400 and r.json()["errors"][0]["fieldName"] == "DateTo"


def test_schedules_future_horizon_and_parent_204(client, site_job, parent_job):
    r = client.get(f"/jobs/v2/api/jobs/{site_job.job_number}/schedules",
                   params={"dateFrom": "2026-09-01", "dateTo": "2026-09-30"}, headers=HEADERS)
    assert r.status_code == 200, "schedules should extend a few weeks past today"
    r = client.get(f"/jobs/v2/api/jobs/{parent_job.job_number}/schedules",
                   params={"dateFrom": "2026-08-01", "dateTo": "2026-08-31"}, headers=HEADERS)
    assert r.status_code == 204
    r = client.get("/jobs/v2/api/jobs/unknown/schedules", params={"dateFrom": "2026-08-01", "dateTo": "2026-08-31"},
                   headers=HEADERS)
    assert r.status_code == 404


def test_schedules_roughly_match_actuals(client, ds, site_job):
    sched = ds.schedules(site_job, date(2026, 7, 1), date(2026, 7, 31))
    planned = sum(r["hours"] for r in sched)
    actual = ds.period_hours(site_job, 2026, 7)
    assert planned > 0 and 0.7 < actual / planned < 1.3


# --------------------------------------------------------------------------- AP invoices

AP_KEYS = ["invoiceNumber", "vendorNumber", "companyNumber", "invoiceDate", "postingDate", "dueDate",
           "invoiceAmount", "poNumber", "notes", "payUseTax", "useTaxAmount", "useTaxCode", "paymentPlanId",
           "paymentMethodId", "creditCardVendorNumber", "memoLine1", "memoLine2", "permanentHold", "includeOn1099"]


def test_ap_invoices_shape(client):
    r = client.get("/accounts/v1/api/payables/invoices",
                   params={"dateFrom": "2026-06-01", "dateTo": "2026-06-30"}, headers=HEADERS)
    rows = assert_paged_envelope(r.json(), 1, 100)
    for row in rows:
        assert list(row) == AP_KEYS
        assert isinstance(row["invoiceNumber"], str) and isinstance(row["vendorNumber"], int)
        assert DATE_RE.match(row["invoiceDate"]) and DATE_RE.match(row["dueDate"])
        assert "2026-06-01" <= row["invoiceDate"][:10] <= "2026-06-30"
        assert row["dueDate"] > row["invoiceDate"]
    r = client.get("/accounts/v1/api/payables/invoices",
                   params={"dateFrom": "2026-06-01", "dateTo": "2026-06-30", "searchFieldName": "VendorNumber",
                           "searchText": str(rows[0]["vendorNumber"])}, headers=HEADERS)
    assert all(x["vendorNumber"] == rows[0]["vendorNumber"] for x in r.json()["data"][0]["results"])
    r = client.get("/accounts/v1/api/payables/invoices", params={"dateFrom": "2031-01-01", "dateTo": "2031-01-31"},
                   headers=HEADERS)
    assert r.status_code == 204


# --------------------------------------------------------------------------- AR invoices

AR_KEYS = ["invoiceNumber", "invoiceDate", "postingDate", "billingPeriodFrom", "billingPeriodTo", "notes", "terms",
           "termsId", "salesRep", "salesRepId", "poNumber", "reason", "reasonId", "jobNumber", "tax", "amountPaid",
           "revenueTotal", "lastDatePaid", "collectionStatus", "invoiceTotal", "invoiceBeingCredited",
           "customerNumber"]


def test_ar_invoices_shape_with_and_without_trailing_slash(client, ds):
    account = ds.accounts[0]
    a = client.get("/accounts/v1/api/receivables/invoices/", params={"customerNumber": account.customer_number},
                   headers=HEADERS)
    b = client.get("/accounts/v1/api/receivables/invoices", params={"customerNumber": account.customer_number},
                   headers=HEADERS)
    assert a.status_code == b.status_code == 200 and a.json() == b.json()
    rows = assert_paged_envelope(a.json(), 1, 100)
    for row in rows:
        assert list(row) == AR_KEYS
        assert isinstance(row["invoiceNumber"], int) and isinstance(row["jobNumber"], str)
        assert row["customerNumber"] == account.customer_number
        assert row["jobNumber"] in account.job_numbers
        assert DATE_RE.match(row["invoiceDate"]) and DATE_RE.match(row["billingPeriodFrom"])
        assert row["billingPeriodTo"] >= row["billingPeriodFrom"] and row["invoiceDate"] > row["billingPeriodTo"]
        assert abs(row["invoiceTotal"] - (row["revenueTotal"] + row["tax"])) < 0.02
        assert row["terms"] in {"Net 30", "Net 45", "Due Upon Receipt"}
        assert (row["lastDatePaid"] is None) == (row["amountPaid"] == 0)
    numbers = [r["invoiceNumber"] for r in rows]
    assert numbers == sorted(numbers)


def test_ar_invoices_cover_every_account_and_include_credit(client, ds):
    all_rows = []
    for account in ds.accounts:
        rows, total = collect_all(client, "/accounts/v1/api/receivables/invoices/",
                                  {"customerNumber": account.customer_number}, 50)
        expected = [r for r in ds.ar_invoices if r["customerNumber"] == account.customer_number]
        assert total == len(rows) == len(expected)
        assert {r["jobNumber"] for r in rows} <= set(account.job_numbers)
        all_rows.extend(rows)
    assert sum(1 for a in ds.accounts if any(r["customerNumber"] == a.customer_number for r in all_rows)) >= 8
    credits = [r for r in all_rows if r["invoiceBeingCredited"] is not None]
    assert len(credits) == 1 and credits[0]["revenueTotal"] < 0 and credits[0]["reason"] == "Missed Service"
    assert credits[0]["invoiceBeingCredited"] in {r["invoiceNumber"] for r in all_rows}
    slow = next(a for a in ds.accounts if a.template.get("slow_payer"))
    slow_rows = [r for r in all_rows if r["customerNumber"] == slow.customer_number]
    cutoff = (TODAY - timedelta(days=60)).isoformat()
    old_open = [r for r in slow_rows if r["invoiceDate"][:10] <= cutoff and r["amountPaid"] < r["invoiceTotal"]]
    assert old_open, "slow payer should carry 60-90+ day balances"
    assert any(r["collectionStatus"] == "Past Due" for r in old_open)
    assert len({r["invoiceNumber"] for r in all_rows}) == len(all_rows)


def test_ar_invoices_require_customer_number(client):
    r = client.get("/accounts/v1/api/receivables/invoices/", headers=HEADERS)
    assert r.status_code == 400
    assert_error_envelope(r.json(), "CustomerNumber", None)
    r = client.get("/accounts/v1/api/receivables/invoices/", params={"customerNumber": "9999"}, headers=HEADERS)
    assert r.status_code == 204


# --------------------------------------------------------------------------- AP payments

PAY_KEYS = ["paymentId", "paymentMethodId", "paymentMethodDescription", "checkNumber", "checkDate",
            "paymentDateAdded", "amount", "companyNumber", "companyName", "glCashAccount", "payeeTypeId",
            "payeeTypeDescription", "vendorNumber", "vendorName", "otherVendorId", "otherVendorName",
            "applyToExpenses", "isSystemGenerated", "externalSystemId"]


def test_ap_payments_shape_and_matching(client, ds):
    r = client.get("/accounts/v1/api/payables/payments",
                   params={"startDate": "2026-07-01T00:00:00Z", "endDate": "2026-07-31T00:00:00Z", "pageSize": 1000},
                   headers=HEADERS)
    rows = assert_paged_envelope(r.json(), 1, 1000)
    invoice_amounts = {(i["vendorNumber"], i["invoiceAmount"]) for i in ds.ap_invoices}
    matched = 0
    for row in rows:
        assert list(row) == PAY_KEYS
        assert DATE_RE.match(row["checkDate"]) and "2026-07-01" <= row["checkDate"][:10] <= "2026-07-31"
        assert row["paymentMethodDescription"] in {"Check", "EFT", "Debit"}
        assert (row["paymentMethodId"] == 1) == (row["checkNumber"] > 0)
        matched += (row["vendorNumber"], row["amount"]) in invoice_amounts
    assert matched / len(rows) > 0.6, "most payments should match an invoice amount"
    r = client.get("/accounts/v1/api/payables/payments", params={"startDate": "2026-07-01"}, headers=HEADERS)
    assert r.status_code == 400 and r.json()["errors"][0]["fieldName"] == "EndDate"
    r = client.get("/accounts/v1/api/payables/payments", params={"startDate": "2031-01-01", "endDate": "2031-01-31"},
                   headers=HEADERS)
    assert r.status_code == 204


def test_recent_ap_invoices_are_partly_unpaid(ds):
    paid = {(p["vendorNumber"], p["amount"]) for p in ds.ap_payments}
    recent = [i for i in ds.ap_invoices if i["invoiceDate"][:10] >= "2026-08-10"]
    assert recent and not all((i["vendorNumber"], i["invoiceAmount"]) in paid for i in recent)


# --------------------------------------------------------------------------- vendors

VENDOR_KEYS = ["vendorNumber", "vendorTypeId", "vendorName", "vendorStatus", "address", "phone", "fax",
               "parentVendorNumber", "accountNumber", "taxID", "customFields", "contactsInformation"]
CONTACT_KEYS = ["displayName", "firstName", "lastName", "email", "businessPhone", "roleId"]


def test_vendors_shape_with_and_without_trailing_slash(client):
    a = client.get("/vendors/v1/api/vendors/", headers=HEADERS)
    b = client.get("/vendors/v1/api/vendors", headers=HEADERS)
    assert a.status_code == b.status_code == 200 and a.json() == b.json()
    rows = assert_paged_envelope(a.json(), 1, 100)
    assert len(rows) == 25
    for v in rows:
        assert list(v) == VENDOR_KEYS
        assert list(v["address"]) == ["address1", "address2", "city", "state", "zip"]
        assert all(list(c) == CONTACT_KEYS for c in v["contactsInformation"])
        assert isinstance(v["vendorNumber"], int) and v["vendorStatus"] is True
    r = client.get("/vendors/v1/api/vendors/", params={"vendorNumber": rows[3]["vendorNumber"]}, headers=HEADERS)
    assert r.json()["data"][0]["totalCount"] == 1 and r.json()["data"][0]["results"][0] == rows[3]
    r = client.get("/vendors/v1/api/vendors/", params={"searchFieldName": "City", "searchText": rows[0]["address"]["city"]},
                   headers=HEADERS)
    assert all(v["address"]["city"] == rows[0]["address"]["city"] for v in r.json()["data"][0]["results"])
    r = client.get("/vendors/v1/api/vendors/", params={"orderBy": "VendorName", "ascending": "false"}, headers=HEADERS)
    names = [v["vendorName"].lower() for v in r.json()["data"][0]["results"]]
    assert names == sorted(names, reverse=True)
    assert client.get("/vendors/v1/api/vendors/", params={"vendorNumber": 1}, headers=HEADERS).status_code == 204


# --------------------------------------------------------------------------- determinism

def test_two_instances_with_same_seed_are_identical():
    a = Dataset(small_config(jobs=10, months=3))
    b = Dataset(small_config(jobs=10, months=3))
    assert a.fingerprint() == b.fingerprint()
    assert len(a.tk) == len(b.tk) and a.tk[:50] == b.tk[:50]
    assert a.ar_invoices == b.ar_invoices and a.ap_payments == b.ap_payments
    c = Dataset(small_config(jobs=10, months=3, seed=8))
    assert c.fingerprint() != a.fingerprint()


def test_two_apps_serve_identical_pages():
    x = TestClient(create_app(small_config(jobs=6, months=2)))
    y = TestClient(create_app(small_config(jobs=6, months=2)))
    for path, params in [
        ("/jobs/v2/api/jobs", {}),
        ("/timekeeping/v2/api/timekeeping", {"dateFrom": "2026-08-01", "dateTo": "2026-08-31", "pageSize": 500}),
        ("/accounts/v1/api/receivables/invoices/", {"customerNumber": "1001"}),
        ("/accounts/v1/api/payables/payments", {"startDate": "2026-07-01", "endDate": "2026-08-31"}),
    ]:
        assert x.get(path, params=params, headers=HEADERS).json() == y.get(path, params=params, headers=HEADERS).json()


def test_scale_env_parsing():
    cfg = SimConfig.from_env({"SIM_SEED": "3", "SIM_JOBS": "5", "SIM_MONTHS": "2", "SIM_TODAY": "2026-09-01",
                              "SIM_RATE_LIMIT_EVERY": "0"})
    assert (cfg.seed, cfg.jobs, cfg.months, cfg.today) == (3, 5, 2, TODAY)
    assert cfg.tenant_id == TENANT and cfg.subscription_key is None
    ds = Dataset(cfg)
    assert ds.summary()["counts"]["siteJobs"] == 5
