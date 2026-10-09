"""Pure tests of the HrDashboard connector (no database, no network): tenant mapping, row shaping,
and error mapping."""
from __future__ import annotations

from datetime import date

import httpx
import pytest

from app.sources import hrdashboard

COMPANIES = {"primary": "Crane", "SAR": "Sarus"}
ROW = {"tenant": "SAR", "jobNumber": "1001", "weekStart": "2026-10-05", "weekEnd": "2026-10-11", "hires": 2,
       "separations": 1, "budgetedPositions": 12, "positionsSource": "tracker", "filledPositions": 10,
       "openPositions": 2, "activeHeadcount": 11, "headcountSource": "employee_master"}


def client(body: dict, status: int = 200) -> httpx.Client:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.url.params)
        return httpx.Response(status, json=body)
    c = httpx.Client(base_url="http://hr.test", transport=httpx.MockTransport(handler))
    c.seen = seen  # type: ignore[attr-defined]
    return c


def test_reads_tenant_companies():
    assert hrdashboard.tenant_companies("primary:Crane, SAR:Sarus,,bad") == COMPANIES


def test_maps_a_sarus_row_to_the_sarus_database():
    row = hrdashboard.staffing_row(ROW, COMPANIES, date(2026, 10, 9))
    assert row == ("Sarus", "1001", date(2026, 10, 5), 2, 1, 12.0, "tracker", 10, 2, 11, "employee_master", date(2026, 10, 9))
    assert len(row) == hrdashboard.UPSERT_SQL.split("VALUES", 1)[1].count("%s")


def test_keeps_unknown_current_figures_null():
    past = {**ROW, "tenant": "primary", "budgetedPositions": None, "positionsSource": None, "filledPositions": None,
            "openPositions": None, "activeHeadcount": None, "headcountSource": None}
    row = hrdashboard.staffing_row(past, COMPANIES, None)
    assert row[0] == "Crane" and row[5:11] == (None, None, None, None, None, None)


def test_skips_rows_it_cannot_key():
    assert hrdashboard.staffing_row({**ROW, "tenant": "XYZ"}, COMPANIES, None) is None
    assert hrdashboard.staffing_row({**ROW, "jobNumber": ""}, COMPANIES, None) is None
    assert hrdashboard.staffing_row({**ROW, "weekStart": "soon"}, COMPANIES, None) is None


def test_drops_values_outside_the_contract():
    row = hrdashboard.staffing_row({**ROW, "positionsSource": "guess", "headcountSource": "x"}, COMPANIES, None)
    assert row[6] is None and row[10] is None


def test_asks_for_the_lookback_window():
    c = client({"asOf": "2026-10-09", "weeks": [], "data": []})
    hrdashboard.fetch(c, date(2026, 10, 9))
    assert c.seen == {"from": "2026-08-21", "to": "2026-10-09"}  # type: ignore[attr-defined]


@pytest.mark.parametrize("status,match", [(401, "refused"), (503, "not configured"), (500, "HTTP 500")])
def test_maps_hr_errors(status, match):
    with pytest.raises(hrdashboard.HrDashboardError, match=match):
        hrdashboard.fetch(client({}, status=status), date(2026, 10, 9))


def test_rejects_a_response_without_data():
    with pytest.raises(hrdashboard.HrDashboardError, match="no data list"):
        hrdashboard.fetch(client({"asOf": "2026-10-09"}), date(2026, 10, 9))
