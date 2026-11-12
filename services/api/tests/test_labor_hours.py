"""The labor hours report (app/labor_hours.py): hours by employee and site, no pay data, behind its own permission."""
from __future__ import annotations

import json
from datetime import date

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app import labor_hours as lh
from app import common, normalize, permissions
from app.auth import User

D1, D2 = date(2026, 10, 26), date(2026, 10, 27)


def punch(employee: str, job: str, day: date, hours: float, **kw) -> dict:
    return {"company": "Crane West", "employee_source_id": employee, "work_date": day, "hours": hours, "lunch": 0.5, "hours_type": None,
            "category_detail_id": 104, "in_time": "08:00", "out_time": "16:30", "job_company": "Crane West", "job_number": job,
            "job_name": f"Site {job}", "city": "Tracy", "state_province": "CA", "rate": 25.0, "labor_cost": 200.0, **kw}


def report(rows: list[dict]) -> dict:
    return lh.build(rows, {("Crane West", "1"): "Ana"}, {"104": "Ops/Regular"}, D1, D2, ["CA"])


def test_totals_add_up_across_employees_and_sites():
    r = report([punch("1", "64", D1, 8), punch("1", "641", D1, 2), punch("1", "64", D2, 8), punch("2", "64", D1, -1.5)])
    assert r["totals"] == {"employees": 2, "sites": 2, "punches": 4, "hours": 16.5}
    ana = next(e for e in r["employees"] if e["employee_number"] == "1")
    assert (ana["employee_name"], ana["sites"], ana["days"], ana["hours"], ana["lunch_hours"]) == ("Ana", 2, 2, 18, 1.5)
    site = next(s for s in r["sites"] if s["job_number"] == "64")
    assert (site["employees"], site["punches"], site["hours"]) == (2, 3, 14.5)
    assert r["through"] == D2.isoformat()


def test_the_same_number_at_two_companies_is_two_employees():
    r = report([punch("1", "64", D1, 8), punch("1", "64", D1, 4, company="Crane IFS")])
    assert r["totals"]["employees"] == 2 and r["totals"]["sites"] == 1


def test_no_pay_data_leaves_the_report():
    body = json.dumps(report([punch("1", "64", D1, 8)]))
    assert "rate" not in body and "labor_cost" not in body and "25.0" not in body and "200.0" not in body


def test_an_employee_without_a_name_keeps_a_number():
    e = report([punch("9", "64", D1, 8)])["employees"][0]
    assert e["employee_number"] == "9" and e["employee_name"] is None


def test_hours_type_prefers_the_export_then_the_setting_then_the_id():
    labels = {"104": "Ops/Regular"}
    assert lh.hours_type({"hours_type": "FedEx/Pallet", "category_detail_id": 104}, labels) == "FedEx/Pallet"
    assert lh.hours_type({"hours_type": None, "category_detail_id": 104}, labels) == "Ops/Regular"
    assert lh.hours_type({"hours_type": None, "category_detail_id": 7}, labels) == "Type 7"
    assert lh.hours_type({"hours_type": None, "category_detail_id": None}, labels) is None


def test_the_period():
    assert lh.default_range(date(2026, 11, 3)) == (date(2026, 10, 26), date(2026, 11, 1))
    assert lh.default_range(date(2026, 11, 2)) == (date(2026, 10, 26), date(2026, 11, 1))  # Monday: the week just ended
    lh.validate_range(date(2026, 1, 1), date(2026, 4, 2))  # 92 days
    with pytest.raises(ValueError):
        lh.validate_range(date(2026, 1, 1), date(2026, 4, 3))
    with pytest.raises(ValueError):
        lh.validate_range(D2, D1)


def test_states_setting():
    assert lh.states_setting(["ca", " NV "]) == ["CA", "NV"]
    assert lh.states_setting(None) == []


def test_only_administrators_hold_the_report_by_default():
    assert permissions.effective("admin", None)["report.labor-hours"]
    assert not permissions.effective("executive", None)["report.labor-hours"]
    assert not permissions.effective("analyst", None)["report.labor-hours"]
    assert permissions.effective("executive", {"report.labor-hours": True})["report.labor-hours"]


@pytest.fixture()
def gated(monkeypatch):
    who: dict = {}
    monkeypatch.setattr(common, "current_user", lambda request: who.get("user"))
    app = FastAPI()
    @app.get("/labor-hours", dependencies=[Depends(common.require_access("report.labor-hours", scoped=True))])
    def route():
        return {"ok": True}
    return TestClient(app), who


@pytest.mark.parametrize(("role", "overrides", "accounts", "status"), [
    ("admin", {}, (), 200),
    ("analyst", {}, (), 403),
    ("executive", {}, (), 403),
    ("analyst", {"report.labor-hours": True}, (), 200),
    ("analyst", {"report.labor-hours": True}, ("fedex",), 200),  # the report then filters to the account's sites
])
def test_the_route_is_gated(gated, role, overrides, accounts, status):
    client, who = gated
    who["user"] = User(username="u", role=role, permissions=overrides, accounts=accounts)
    assert client.get("/labor-hours").status_code == status


def test_the_route_needs_a_session(gated):
    client, _ = gated
    assert client.get("/labor-hours").status_code == 401


def test_punch_times_accept_a_time_of_day():
    in_sql, out_sql = normalize.punch_time("inTime"), normalize.punch_time("outTime", after="inTime")
    assert normalize.CLOCK_RE in in_sql and "interval '1 day'" not in in_sql
    assert "interval '1 day'" in out_sql and normalize.TIMESTAMP_RE in out_sql


def test_hr_names_win_and_the_export_fills_in():
    rows = [punch("1", "64", D1, 8), punch("2", "64", D1, 8), punch("3", "64", D1, 8), punch("1", "9", D1, 8, company="Sarus")]
    hr = {("Crane", "1"): "Person, Hr", ("Sarus", "1"): "Person, Sarus"}
    export = {("Crane West", "1"): "Old, Name", ("Crane West", "2"): "Export, Only"}
    assert lh.names_for(rows, hr, export) == {
        ("Crane West", "1"): "Person, Hr", ("Crane West", "2"): "Export, Only", ("Sarus", "1"): "Person, Sarus"}


def test_titles_come_from_hr_by_winteam_database():
    rows = [punch("1", "64", D1, 8), punch("2", "64", D1, 8), punch("1", "9", D1, 8, company="Sarus")]
    titles = lh.titles_for(rows, {("Crane", "1"): "Supervisor", ("Sarus", "1"): "Cleaner"})
    assert titles == {("Crane West", "1"): "Supervisor", ("Sarus", "1"): "Cleaner"}
    built = lh.build(rows, {}, {}, D1, D2, ["CA"], titles)
    assert {(e["company"], e["employee_number"]): e["title"] for e in built["employees"]} == {
        ("Crane West", "1"): "Supervisor", ("Crane West", "2"): None, ("Sarus", "1"): "Cleaner"}
    assert all(e["title"] is None for e in report(rows)["employees"])


def test_full_name():
    assert lh.full_name("Test", "Person") == "Person, Test"
    assert lh.full_name("", "Person") == "Person"
