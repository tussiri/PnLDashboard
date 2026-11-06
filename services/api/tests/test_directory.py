"""The account directory (app/directory.py) and the Apple delivery rule (normalize.apply_delivery_models)."""
from __future__ import annotations

from datetime import date, datetime, timezone

from app import directory, normalize, permissions
from app.sources import rules

D1, D2 = date(2026, 11, 2), date(2026, 11, 4)


def site(job_key: int, name: str = "Apple - R550 - Valley Plaza", **kw) -> dict:
    return {"job_key": job_key, "company": "Crane West", "job_number": str(1000 + job_key), "job_name": name, "address_line_1": "2701 Ming Avenue",
            "address_line_2": None, "city": "Bakersfield", "state_province": "CA", "postal_code": "93304", "latitude": 35.3, "longitude": -119.0,
            "region_name": "West", "branch_name": "Bakesfield", "manager_name": "M", "vertical": "Self-Service", "delivery_model": "self_perform",
            "date_to_start": date(2026, 11, 1), "is_active": True, "last_seen_at": datetime(2026, 11, 4, tzinfo=timezone.utc), **kw}


def punch(job_key: int, who: str, hours: float, day: date = D1, company: str = "Crane West") -> dict:
    return {"job_key": job_key, "company": company, "employee_source_id": who, "hours": hours, "work_date": day}


def test_name_splits_into_store_number_and_name():
    assert directory.split_name("Apple - R550 - Valley Plaza") == ("R550", "Valley Plaza")
    assert directory.split_name("Amazon - LGB3") == ("LGB3", "LGB3")
    assert directory.split_name("Plain site") == (None, "Plain site")
    assert directory.split_name(None) == (None, None)


def test_a_site_nobody_has_worked_still_lists():
    out = directory.build([site(1), site(2, delivery_model="subcontracted", vertical="3rd Party Subcontractor")], [punch(1, "7", 8)])
    assert [s["hours_28d"] for s in out["sites"]] == [8, 0]
    assert out["sites"][1]["last_punch"] is None
    assert out["totals"] == {"sites": 2, "active": 2, "self_perform": 1, "subcontracted": 1, "unassigned": 0, "working": 1, "hours_28d": 8, "employees_28d": 1}


def test_an_employee_at_two_sites_counts_once_in_totals():
    out = directory.build([site(1), site(2)], [punch(1, "7", 8, D1), punch(2, "7", 4, D2), punch(2, "8", 2, D1)])
    assert [(s["employees_28d"], s["last_punch"]) for s in out["sites"]] == [(1, D1), (2, D2)]
    assert out["totals"]["employees_28d"] == 2 and out["totals"]["hours_28d"] == 14


def test_the_same_employee_number_at_two_companies_is_two_people():
    out = directory.build([site(1)], [punch(1, "7", 8), punch(1, "7", 8, company="Crane IFS")])
    assert out["totals"]["employees_28d"] == 2


def test_no_pay_in_the_response():
    assert not {"rate", "labor_cost", "pay"} & set(directory.build([site(1)], [])["sites"][0])


def test_the_apple_term_matches_stores_and_not_appleton():
    groups = [{"name": "Apple", "terms": ["apple - r"]}, {"name": "Plano ISD", "terms": ["plano"]}, {"name": "FedEx", "terms": ["fxe"]}]
    match = lambda name: rules.match_account_group(job_number="1", job_name=name, customer_names=[], groups=groups)  # noqa: E731
    assert match("Apple - R550 - Valley Plaza") == "Apple"
    assert match("Apple - R999 - Plano Shops") == "Apple"
    assert match("FXE_ATWA Appleton WI") == "FedEx"


class FakeCursor:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql: str, params: dict) -> None:
        assert "delivery_declared IS NULL" in sql  # a value already there stays
        self.calls.append(params)


def test_delivery_rule_runs_per_group_and_tier(monkeypatch):
    cursor = FakeCursor()
    conn = type("C", (), {"cursor": lambda self: cursor})()
    monkeypatch.setattr(normalize, "_setting", lambda _c, _k, _d: {"Apple": {"Self-Service": "self_perform", "3rd Party Subcontractor": "subcontracted"}})
    assert normalize.apply_delivery_models(conn) == 2
    assert {"model": "subcontracted", "group": "Apple", "vertical": "3rd Party Subcontractor"} in cursor.calls


def test_the_directory_is_on_for_every_role_by_default():
    for role in ("executive", "analyst", "admin"):
        assert permissions.effective(role, None)["tab.directory"]
