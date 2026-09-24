"""Pure tests of the Relay connector (no database, no network): paging, error mapping, row shaping,
and one failed feed not stopping the others."""
from __future__ import annotations

from dataclasses import replace
from datetime import date

import httpx
import pytest

from app import relay

AP = {"id": 7, "winteam_job_number": "479", "job_source": "ar_invoice", "service_month": "2026-07", "station": "479",
      "subtype": "dock", "correlation_key": "479|dock|2026-07", "vendor_number": "1140", "vendor_name": "Sub Co",
      "vendor_invoice_number": "163040", "work_order_number": "WO1", "is_placeholder": False, "amount": 366.34,
      "ar_invoice_number": "164387", "status": "exported", "in_winteam": True, "winteam_ref": "WT1",
      "payment_status": "paid", "paid_amount": 366.34, "paid_date": "2026-08-20T00:00:00+00:00", "check_number": "5001",
      "self_perform": False, "recorded_at": "2026-08-02T10:00:00+00:00", "pushed_at": None,
      "match_confidence": "high", "updated_at": "2026-08-21T00:00:00Z"}


def client(pages: dict[int, dict], status: int = 200) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params.get("page", "1"))
        return httpx.Response(status, json=pages.get(page, {"page": page, "limit": 2, "count": 0, "total": 0, "data": []}))
    return httpx.Client(base_url="http://relay.test", transport=httpx.MockTransport(handler))


def test_fetches_every_page():
    pages = {1: {"page": 1, "limit": 2, "count": 2, "total": 3, "data": [{"id": 1}, {"id": 2}]},
             2: {"page": 2, "limit": 2, "count": 1, "total": 3, "data": [{"id": 3}]}}
    assert [r["id"] for r in relay.fetch_feed(client(pages), "/export/dashboard/ap")] == [1, 2, 3]


@pytest.mark.parametrize("status,match", [(401, "refused"), (503, "not configured"), (500, "HTTP 500")])
def test_maps_relay_errors(status, match):
    with pytest.raises(relay.RelayError, match=match):
        relay.fetch_feed(client({}, status=status), "/export/dashboard/ap")


def test_rejects_a_response_without_data():
    bad = {1: {"page": 1, "limit": 2}}
    with pytest.raises(relay.RelayError, match="no data list"):
        relay.fetch_feed(client(bad), "/export/dashboard/ap")


def test_shapes_an_ap_row():
    row = relay.ap_row(AP)
    assert row[0] == 7 and row[1] == "479" and row[3] == date(2026, 7, 1)
    assert row[12] == 366.34 and row[15] is True and row[19] == date(2026, 8, 20) and row[21] is False
    assert row[24].year == 2026 and '"vendor_invoice_number": "163040"' in row[25]
    assert len(row) == relay.FEEDS["ap"][1].count(",") + 1


def test_row_builders_match_their_column_lists():
    samples = {"ar": {"id": 1, "invoice_number": "164387", "service_month": "2026-07", "revenue_before_tax": 7500},
               "sites": {"id": 1, "winteam_job_number": "296", "ap_monthly": 5000},
               "work_orders": {"id": 1, "service_month": "2026-09"}}
    for feed, sample in samples.items():
        assert len(relay.FEEDS[feed][2](sample)) == relay.FEEDS[feed][1].count(",") + 1, feed


def test_month_and_number_parsing():
    assert relay._month("2026-07") == date(2026, 7, 1) and relay._month("2026-07-15") == date(2026, 7, 1)
    assert relay._month("July") is None and relay._month(None) is None
    assert relay._num("12.345") == 12.35 and relay._num("x") is None and relay._text("  ") is None


def test_one_failed_feed_does_not_stop_the_others(monkeypatch):
    monkeypatch.setattr(relay, "settings", replace(relay.settings, relay_base_url="http://relay.test", relay_export_token="tok"))
    recorded = []
    monkeypatch.setattr(relay, "_record", lambda run_id, feed, status, *a: recorded.append((feed, status)))

    def fake_fetch(_client, path):
        if path.endswith("/ar"):
            raise relay.RelayError("Relay answered HTTP 500 on /export/dashboard/ar")
        return [{"id": 1}]
    monkeypatch.setattr(relay, "fetch_feed", fake_fetch)
    monkeypatch.setattr(relay, "replace_snapshot", lambda feed, rows: len(rows))
    result = relay.sync()
    assert result["failed"] == ["ar"]
    assert dict(recorded) == {"ap": "succeeded", "ar": "failed", "sites": "succeeded", "work_orders": "succeeded"}


def test_sync_refuses_without_configuration(monkeypatch):
    monkeypatch.setattr(relay, "settings", replace(relay.settings, relay_base_url="", relay_export_token=""))
    with pytest.raises(relay.RelayError, match="not configured"):
        relay.sync()
