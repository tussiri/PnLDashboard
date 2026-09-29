"""Pure tests of the PhotoValidation staffing-request connector (no database, no network): row mapping,
incremental paging, error mapping, and how a pull is recorded."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import date, datetime, timezone

import httpx
import pytest

from app.sources import photovalidation as pv

ROW = {
    "lineId": "cln1", "requestId": "clr1", "requestCode": "SR-0042",
    "locationId": "clx1", "siteName": "Piedmont North", "accountName": "Georgia State University",
    "winteamJobNumber": "1234", "winteamCompany": "Crane",
    "role": "Custodian", "shift": "night", "shiftStart": "22:00", "shiftEnd": "06:30",
    "headcountNeeded": 2, "currentFilled": 1,
    "reason": "backfill", "employmentType": "full_time", "hoursPerWeek": 40, "payRate": 15.5,
    "neededBy": "2026-10-15",
    "status": "posted", "hireJobId": "H-889",
    "reportedHeadcount": 10,
    "submittedAt": "2026-09-20T14:00:00.000Z", "decidedAt": "2026-09-21T09:30:00.000Z", "postedAt": "2026-09-22T10:00:00.000Z",
    "filledAt": None, "closedAt": None,
    "updatedAt": "2026-09-22T10:00:00.000Z",
}


def col(row: tuple, name: str):
    return row[pv.COLUMNS.index(name)]


# ── mapping ──────────────────────────────────────────────────────────────────
def test_maps_every_contract_field():
    row = pv.request_row(ROW)
    assert len(row) == len(pv.COLUMNS)
    assert col(row, "line_id") == "cln1" and col(row, "request_id") == "clr1" and col(row, "request_code") == "SR-0042"
    assert col(row, "location_id") == "clx1" and col(row, "site_name") == "Piedmont North" and col(row, "account_name") == "Georgia State University"
    assert col(row, "winteam_job_number") == "1234" and col(row, "winteam_company") == "Crane"
    assert (col(row, "role"), col(row, "shift"), col(row, "shift_start"), col(row, "shift_end")) == ("Custodian", "night", "22:00", "06:30")
    assert col(row, "headcount_needed") == 2 and col(row, "current_filled") == 1 and col(row, "reported_headcount") == 10
    assert (col(row, "reason"), col(row, "employment_type"), col(row, "hours_per_week")) == ("backfill", "full_time", 40.0)
    assert col(row, "pay_rate") == 15.5 and col(row, "needed_by") == date(2026, 10, 15)
    assert col(row, "status") == "posted" and col(row, "hire_job_id") == "H-889"
    assert col(row, "submitted_at") == datetime(2026, 9, 20, 14, 0, tzinfo=timezone.utc)
    assert col(row, "posted_at") == datetime(2026, 9, 22, 10, 0, tzinfo=timezone.utc)
    assert col(row, "filled_at") is None and col(row, "closed_at") is None
    assert col(row, "updated_at") == datetime(2026, 9, 22, 10, 0, tzinfo=timezone.utc)
    assert '"payRate": 15.5' in col(row, "payload")


def test_unmapped_site_and_optional_fields_stay_null():
    row = pv.request_row({**ROW, "winteamJobNumber": None, "winteamCompany": None, "payRate": None, "hoursPerWeek": None,
                          "employmentType": None, "hireJobId": None, "reportedHeadcount": None, "neededBy": None})
    for name in ("winteam_job_number", "winteam_company", "pay_rate", "hours_per_week", "employment_type", "hire_job_id",
                 "reported_headcount", "needed_by"):
        assert col(row, name) is None, name


def test_unknown_company_is_not_guessed():
    assert col(pv.request_row({**ROW, "winteamCompany": "crane"}), "winteam_company") is None
    assert col(pv.request_row({**ROW, "winteamCompany": "Sarus"}), "winteam_company") == "Sarus"


@pytest.mark.parametrize("missing", ["lineId", "requestId", "status", "updatedAt"])
def test_rows_that_cannot_be_upserted_are_rejected(missing):
    with pytest.raises(ValueError):
        pv.request_row({**ROW, missing: None})
    tuples, errors = pv.shape([ROW, {**ROW, missing: None}])
    assert len(tuples) == 1 and len(errors) == 1


def test_upsert_statement_matches_the_columns():
    assert pv.UPSERT_SQL.count("%s") == len(pv.COLUMNS)
    assert "ON CONFLICT (line_id)" in pv.UPSERT_SQL and "line_id = EXCLUDED.line_id" not in pv.UPSERT_SQL
    assert "pay_rate = EXCLUDED.pay_rate" in pv.UPSERT_SQL
    # an older copy of a line (a re-read page) never overwrites a newer one
    assert "WHERE core.fact_staffing_request.updated_at <= EXCLUDED.updated_at" in pv.UPSERT_SQL


# ── paging ───────────────────────────────────────────────────────────────────
def line(n: int, updated: str) -> dict:
    return {**ROW, "lineId": f"cln{n}", "updatedAt": updated}


class Feed:
    """A fake PhotoValidation: rows ordered by (updatedAt, lineId), inclusive updatedSince, page/limit."""

    def __init__(self, rows, status: int = 200, body=None, hook=None):
        self.rows = sorted(rows, key=lambda r: (r["updatedAt"], r["lineId"]))
        self.status, self.body, self.hook = status, body, hook
        self.requests: list[dict] = []

    def client(self) -> httpx.Client:
        def handler(request: httpx.Request) -> httpx.Response:
            params = dict(request.url.params)
            self.requests.append({**params, "auth": request.headers.get("authorization")})
            if self.hook:
                self.hook(self, len(self.requests))
            if self.status != 200 or self.body is not None:
                return httpx.Response(self.status, json=self.body if self.body is not None else {"error": "x"})
            since = params.get("updatedSince")
            page, limit = int(params["page"]), int(params["limit"])
            match = [r for r in self.rows if since is None or pv._ts(r["updatedAt"]) >= pv._ts(since)]
            data = match[(page - 1) * limit: page * limit]
            return httpx.Response(200, json={"page": page, "limit": limit, "count": len(data), "data": data})
        return httpx.Client(base_url="http://pv.test", transport=httpx.MockTransport(handler),
                            headers={"Authorization": "Bearer crane_sk_test"})


def test_first_pull_reads_everything_without_updated_since():
    feed = Feed([line(i, f"2026-09-2{i}T00:00:00.000Z") for i in range(1, 6)])
    rows = pv.fetch_since(feed.client(), None, limit=2)
    assert sorted(r["lineId"] for r in rows) == [f"cln{i}" for i in range(1, 6)]
    assert "updatedSince" not in feed.requests[0] and feed.requests[0]["auth"] == "Bearer crane_sk_test"


def test_cursor_advances_to_each_full_pages_last_updated_at():
    feed = Feed([line(i, f"2026-09-2{i}T00:00:00.000Z") for i in range(1, 6)])
    pv.fetch_since(feed.client(), "2026-09-21T00:00:00.000Z", limit=2)
    seen = [(r.get("updatedSince")[:10], r["page"]) for r in feed.requests]
    assert seen == [(f"2026-09-2{i}", "1") for i in range(1, 6)]


def test_a_page_sharing_one_timestamp_advances_the_page_number():
    same = "2026-09-25T12:00:00.000Z"
    feed = Feed([line(i, same) for i in range(1, 6)] + [line(9, "2026-09-26T00:00:00.000Z")])
    rows = pv.fetch_since(feed.client(), same, limit=2)
    assert sorted(r["lineId"] for r in rows) == ["cln1", "cln2", "cln3", "cln4", "cln5", "cln9"]
    assert [r["page"] for r in feed.requests][:3] == ["1", "2", "3"]


def test_a_line_seen_twice_keeps_its_latest_version():
    def edit(feed, n):
        if n == 2:  # line 1 is edited while the pull pages: it moves behind line 2
            feed.rows = [line(2, "2026-09-22T00:00:00.000Z"), {**line(1, "2026-09-23T00:00:00.000Z"), "status": "filled"}]
    feed = Feed([line(1, "2026-09-21T00:00:00.000Z"), line(2, "2026-09-22T00:00:00.000Z")], hook=edit)
    got = {r["lineId"]: r for r in pv.fetch_since(feed.client(), None, limit=2)}
    assert got["cln1"]["status"] == "filled" and set(got) == {"cln1", "cln2"}


def test_an_empty_feed_is_one_request():
    feed = Feed([])
    assert pv.fetch_since(feed.client(), "2026-09-29T00:00:00.000Z") == [] and len(feed.requests) == 1


@pytest.mark.parametrize("status,match", [(401, "refused"), (403, "refused"), (500, "HTTP 500")])
def test_maps_errors(status, match):
    with pytest.raises(pv.PhotoValidationError, match=match):
        pv.fetch_since(Feed([], status=status).client(), None)


def test_rejects_a_response_without_data():
    with pytest.raises(pv.PhotoValidationError, match="no data list"):
        pv.fetch_since(Feed([], body={"page": 1, "limit": 500}).client(), None)


def test_request_cap_stops_a_runaway_pull():
    feed = Feed([line(i, "2026-09-25T12:00:00.000Z") for i in range(1, 20)])
    with pytest.raises(pv.PhotoValidationError, match="more than 3 requests"):
        pv.fetch_since(feed.client(), None, limit=2, max_requests=3)


# ── sync bookkeeping ─────────────────────────────────────────────────────────
class FakeCursor:
    def __init__(self, watermark_at):
        self.watermark_at = watermark_at

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sql = sql

    def fetchone(self):
        return {"at": self.watermark_at}


class FakeConn:
    def __init__(self, watermark_at=None):
        self.watermark_at = watermark_at
        self.commits = 0

    def cursor(self):
        return FakeCursor(self.watermark_at)

    def commit(self):
        self.commits += 1


@pytest.fixture
def wired(monkeypatch):
    state = {"records": [], "upserts": [], "conn": FakeConn(datetime(2026, 9, 22, 10, 0, tzinfo=timezone.utc)), "feed": Feed([ROW])}
    monkeypatch.setattr(pv, "settings", replace(pv.settings, photovalidation_api_url="http://pv.test", photovalidation_api_token="crane_sk_test"))

    @contextmanager
    def fake_connection(**_):
        yield state["conn"]
    monkeypatch.setattr(pv, "connection", fake_connection)
    monkeypatch.setattr(pv, "_client", lambda: state["feed"].client())
    monkeypatch.setattr(pv, "_record", lambda run_id, status, started, fetched, loaded, error: state["records"].append((status, fetched, loaded, error)))
    monkeypatch.setattr(pv, "upsert", lambda conn, tuples: state["upserts"].append(tuples) or {"loaded": len(tuples), "job_keys_changed": 1, "job_week_rows_changed": 3})
    return state


def test_sync_passes_the_watermark_back_and_records_the_run(wired):
    result = pv.sync()
    assert result["status"] == "succeeded" and result["since"] == "2026-09-22T10:00:00Z"
    assert wired["feed"].requests[0]["updatedSince"] == "2026-09-22T10:00:00Z"
    assert result["loaded"] == 1 and result["job_week_rows_changed"] == 3
    assert wired["records"] == [("succeeded", 1, 1, None)]


def test_sync_records_rejected_rows(wired):
    wired["feed"] = Feed([ROW, {**line(2, "2026-09-23T00:00:00.000Z"), "requestId": None}])
    result = pv.sync()
    assert result["rejected"] == 1 and result["loaded"] == 1
    assert wired["records"][0][0] == "succeeded" and "1 row(s) rejected" in wired["records"][0][3]


def test_sync_failure_is_recorded_and_returned(wired):
    wired["feed"] = Feed([], status=401)
    result = pv.sync()
    assert result["status"] == "failed" and "refused" in result["error"]
    assert wired["records"][0][0] == "failed" and wired["upserts"] == []


def test_sync_refuses_without_configuration(monkeypatch):
    monkeypatch.setattr(pv, "settings", replace(pv.settings, photovalidation_api_url="", photovalidation_api_token=""))
    with pytest.raises(pv.PhotoValidationError, match="not configured"):
        pv.sync()
