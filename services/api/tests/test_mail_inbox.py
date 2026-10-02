"""The reports mailbox poller (app/mail_inbox.py) against a fake Microsoft Graph and an in-memory
stand-in for the two tables it touches. No network, no database."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from typing import Any

import httpx
import pytest

from app import imports, mail_inbox, marts

JOB_COST = b"ExportRunDate,FiscalYear,FiscalPeriod,PeriodStartDate,CompanyNumber,CompanyName,JobNumber,JobDescription,GLAccountNumber,ActualDollars\n" \
           b"10/2/2026,2026,9,9/1/2026,2,Crane West Opco LLC,39,FedEx - Bloomington,40100,19674.57\n"
OTHER_REPORT = b"Invoice,Customer,Amount\n1001,ACME,500\n"


def graph_transport(messages: list[dict[str, Any]], attachments: dict[str, list[dict[str, Any]]], files: dict[str, bytes], seen: list[str], status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(f"{request.method} {request.url.path}")
        if request.url.host == "login.microsoftonline.com":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        assert request.headers["authorization"] == "Bearer tok"
        if status != 200:
            return httpx.Response(status, json={})
        path = request.url.path
        if path.endswith("/mailFolders/inbox/messages"):
            if request.url.params.get("page") == "2":
                return httpx.Response(200, json={"value": messages[1:]})
            assert "receivedDateTime ge" in request.url.params["$filter"] and "hasAttachments eq true" in request.url.params["$filter"]
            return httpx.Response(200, json={"value": messages[:1], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/x/mailFolders/inbox/messages?page=2"})
        if path.endswith("/$value"):
            return httpx.Response(200, content=files[path.split("/")[-2]])
        if path.endswith("/attachments"):
            return httpx.Response(200, json={"value": attachments[path.split("/")[-2]]})
        return httpx.Response(404)
    return httpx.MockTransport(handler)


class FakeDb:
    """ops.mail_attachment and the one app_setting row, enough for poll()."""

    def __init__(self):
        self.rows: dict[tuple[str, str], tuple] = {}

    @contextmanager
    def connection(self, *a, **k):
        db = self

        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, sql, params=None):
                self.sql, self.params = sql, params
            def fetchone(self):
                if "max(received_at)" in self.sql:
                    return {"last": max((r[2] for r in db.rows.values()), default=None)}
                if "FROM ops.mail_attachment WHERE" in self.sql:
                    return (1,) if tuple(self.params) in db.rows else None
                if "app_setting" in self.sql:
                    return None
                return None

            def close(self): pass

        class Conn:
            def cursor(self): return Cursor()
            def commit(self): pass

        original = Cursor.execute

        def execute(cur, sql, params=None):
            original(cur, sql, params)
            if sql.strip().startswith("INSERT INTO ops.mail_attachment"):
                db.rows.setdefault((params[0], params[1]), params)
        Cursor.execute = execute
        yield Conn()


@pytest.fixture()
def setup(monkeypatch):
    monkeypatch.setattr(mail_inbox, "settings", replace(mail_inbox.settings, graph_tenant_id="t", graph_client_id="c", graph_client_secret="s", graph_mailbox="reports@smcraneifs.com"))
    db = FakeDb()
    monkeypatch.setattr(mail_inbox, "connection", db.connection)
    loads: list[tuple[str, str]] = []
    monkeypatch.setattr(imports, "load_file", lambda conn, name, content, kind=None, origin="upload", uploaded_by=None:
                        loads.append((name, kind, origin, uploaded_by)) or {"status": "loaded", "import_file_id": 7, "errors": []})
    rebuilds: list[str] = []
    monkeypatch.setattr(marts, "rebuild_all", lambda initiated_by="x": rebuilds.append(initiated_by))
    return db, loads, rebuilds


def message(mid: str, subject: str, when: str = "2026-10-02T10:05:00Z") -> dict[str, Any]:
    return {"id": mid, "subject": subject, "receivedDateTime": when, "from": {"emailAddress": {"address": "winteam@smcraneifs.com"}}}


def test_loads_dashboard_reports_ignores_the_rest_and_handles_each_attachment_once(setup):
    db, loads, rebuilds = setup
    messages = [message("m1", "Job Cost Analysis"), message("m2", "AR aging")]
    attachments = {"m1": [{"id": "a1", "name": "Crane_job_cost_analysis_monthly20261002.csv", "size": 200}, {"id": "a2", "name": "logo.png", "size": 10}],
                   "m2": [{"id": "a3", "name": "ar_aging.csv", "size": 50}]}
    files = {"a1": JOB_COST, "a3": OTHER_REPORT}
    seen: list[str] = []
    graph = mail_inbox.Graph(httpx.Client(transport=graph_transport(messages, attachments, files, seen)))
    result = mail_inbox.poll(graph)
    assert result == {"loaded": 1, "duplicate": 0, "failed": 0, "ignored": 2, "messages": 2, "rebuilt": True}
    assert loads == [("Crane_job_cost_analysis_monthly20261002.csv", "job_cost", "mail", "mail:winteam@smcraneifs.com")]
    assert {k: (v[7], v[8]) for k, v in db.rows.items()} == {("m1", "a1"): ("loaded", None), ("m1", "a2"): ("ignored", "not a CSV or Excel file"),
                                                            ("m2", "a3"): ("ignored", "not a dashboard report")}
    assert not any(s.endswith("a2/$value") for s in seen)  # a non-spreadsheet is never downloaded
    assert all(s.startswith(("GET", "POST /t/oauth2")) for s in seen)  # read-only against Graph
    assert rebuilds == ["mail-inbox"]

    # The next poll sees the same messages (a day of overlap) and handles nothing twice.
    loads.clear(); rebuilds.clear()
    again = mail_inbox.poll(mail_inbox.Graph(httpx.Client(transport=graph_transport(messages, attachments, files, []))))
    assert again["loaded"] == 0 and again["ignored"] == 0 and loads == [] and rebuilds == []


def test_nothing_loaded_means_no_rebuild(setup):
    _db, loads, rebuilds = setup
    graph = mail_inbox.Graph(httpx.Client(transport=graph_transport([message("m9", "Newsletter")], {"m9": [{"id": "b1", "name": "list.xlsx", "size": 5}]},
                                                                    {"b1": b"not a workbook"}, [])))
    assert mail_inbox.poll(graph)["rebuilt"] is False and loads == [] and rebuilds == []


def test_refused_access_is_reported_plainly(setup):
    graph = mail_inbox.Graph(httpx.Client(transport=graph_transport([], {}, {}, [], status=403)))
    with pytest.raises(mail_inbox.MailError, match="refused access to reports@smcraneifs.com"):
        mail_inbox.poll(graph)


def test_unconfigured_mailbox_refuses_to_poll(monkeypatch):
    monkeypatch.setattr(mail_inbox, "settings", replace(mail_inbox.settings, graph_client_secret=""))
    assert mail_inbox.configured() is False
    with pytest.raises(mail_inbox.MailError, match="not configured"):
        mail_inbox.poll()


def test_recognizes_feeds_by_columns():
    assert mail_inbox.recognize("anything.csv", JOB_COST) == "job_cost"
    assert mail_inbox.recognize("ar_aging.csv", OTHER_REPORT) is None
    assert mail_inbox.recognize("broken.xlsx", b"\x00\x01") is None
