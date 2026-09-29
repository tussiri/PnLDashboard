"""Pure tests of the interval schedules (app/schedule.py): no database, no WinTeam, no PhotoValidation."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from app import schedule
from app.config import ConfigurationError, Settings

UTC = timezone.utc
NOW = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)


# ── interval and configuration ──────────────────────────────────────────────
def test_interval_due():
    assert schedule.interval_due(30, None, NOW)
    assert not schedule.interval_due(30, NOW - timedelta(minutes=29, seconds=59), NOW)
    assert schedule.interval_due(30, NOW - timedelta(minutes=30), NOW)
    assert schedule.interval_due(15, NOW - timedelta(hours=5), NOW)


def test_zero_interval_is_off():
    assert not schedule.interval_due(0, None, NOW)
    assert not schedule.interval_due(0, NOW - timedelta(days=3), NOW)


def test_interval_defaults_and_bounds():
    s = Settings.load({})
    assert s.winteam_sync_interval_minutes == 30 and s.pv_sync_interval_minutes == 15
    assert not s.photovalidation_configured
    off = Settings.load({"WINTEAM_SYNC_INTERVAL_MINUTES": "0", "PV_SYNC_INTERVAL_MINUTES": "0"})
    assert off.winteam_sync_interval_minutes == 0 and off.pv_sync_interval_minutes == 0
    with pytest.raises(ConfigurationError):
        Settings.load({"WINTEAM_SYNC_INTERVAL_MINUTES": "-5"})
    with pytest.raises(ConfigurationError):
        Settings.load({"PV_SYNC_INTERVAL_MINUTES": "often"})


def test_photovalidation_url_is_validated():
    ok = Settings.load({"PHOTOVALIDATION_API_URL": "https://pv.example.com/", "PHOTOVALIDATION_API_TOKEN": "crane_sk_x"})
    assert ok.photovalidation_api_url == "https://pv.example.com" and ok.photovalidation_configured
    with pytest.raises(ConfigurationError):
        Settings.load({"PHOTOVALIDATION_API_URL": "ftp://pv.example.com"})
    with pytest.raises(ConfigurationError):
        Settings.load({"PHOTOVALIDATION_API_URL": "https://user:pass@pv.example.com"})


def test_light_resources_follow_the_enabled_list():
    assert schedule.light_resources(("jobs", "vendors", "timekeeping", "ar_invoices")) == ["jobs", "timekeeping"]
    assert schedule.light_resources(("timekeeping",)) == ["timekeeping"]
    assert schedule.light_resources(("jobs", "vendors")) == []  # nothing to do without timekeeping


def test_sync_mode_reports_the_schedule(monkeypatch):
    monkeypatch.setattr(schedule, "settings", replace(schedule.settings, winteam_sync_interval_minutes=30))
    assert schedule.sync_mode() == {"sync": "scheduled", "poll_seconds": 1800}
    assert schedule.sync_mode(ingesting=False) == {"sync": "on_demand", "poll_seconds": None}  # database not configured
    monkeypatch.setattr(schedule, "settings", replace(schedule.settings, winteam_sync_interval_minutes=0))
    assert schedule.sync_mode() == {"sync": "on_demand", "poll_seconds": None}


# ── the light WinTeam run ────────────────────────────────────────────────────
class FakeConnector:
    def __init__(self, integration: str, resources=("jobs", "vendors", "timekeeping"), fail: bool = False, statuses=None):
        self.config = type("C", (), {"winteam_resources": resources})()
        self.tenant = type("T", (), {"integration": integration})()
        self.fail = fail
        self.statuses = statuses or {"jobs": "skipped", "timekeeping": "succeeded"}
        self.calls: list[dict] = []

    def sync_all(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("gateway down")
        return {"runs": [{"resource": r, "status": self.statuses.get(r, "succeeded")} for r in kwargs["resources"]], "normalized": True}


@pytest.fixture
def light(monkeypatch):
    """Wire run_winteam_light to fakes; returns (connectors, rebuilds, lock state, last-start map)."""
    state = {"lock": True, "last": {}, "rebuilds": [], "locks": 0}
    primary, sarus = FakeConnector("winteam"), FakeConnector("winteam_sarus")
    monkeypatch.setattr(schedule, "settings", replace(schedule.settings, winteam_sync_interval_minutes=30))
    monkeypatch.setattr(schedule, "winteam_targets", lambda: [("winteam", primary), ("sarus", sarus)])
    monkeypatch.setattr(schedule, "last_started", lambda integration, resource=None: state["last"].get(integration))

    @contextmanager
    def fake_lock(key):
        assert key == schedule.WINTEAM_SYNC_LOCK
        state["locks"] += 1
        yield state["lock"]
    monkeypatch.setattr(schedule, "advisory_lock", fake_lock)
    from app import marts
    monkeypatch.setattr(marts, "rebuild_all", lambda initiated_by: state["rebuilds"].append(initiated_by) or {"seconds": 1.0})
    return primary, sarus, state


def test_light_sync_uses_the_throttled_entrypoint(light):
    primary, sarus, state = light
    result = schedule.run_winteam_light(NOW)
    assert result["status"] == "succeeded"
    for connector in (primary, sarus):
        assert connector.calls == [{"resources": ["jobs", "timekeeping"], "rebuild": False}]  # never force, never deep
    assert state["rebuilds"] == ["winteam-interval"]  # one rebuild after both databases


def test_light_sync_skips_databases_synced_within_the_interval(light):
    primary, sarus, state = light
    state["last"] = {"winteam": NOW - timedelta(minutes=10), "winteam_sarus": NOW - timedelta(minutes=45)}
    schedule.run_winteam_light(NOW)
    assert primary.calls == [] and len(sarus.calls) == 1


def test_nothing_due_takes_no_lock(light):
    primary, sarus, state = light
    state["last"] = {"winteam": NOW - timedelta(minutes=1), "winteam_sarus": NOW - timedelta(minutes=1)}
    assert schedule.run_winteam_light(NOW) is None
    assert state["locks"] == 0 and state["rebuilds"] == []


def test_interval_zero_disables_the_light_sync(light, monkeypatch):
    primary, _sarus, state = light
    monkeypatch.setattr(schedule, "settings", replace(schedule.settings, winteam_sync_interval_minutes=0))
    assert schedule.run_winteam_light(NOW) is None
    assert primary.calls == [] and state["locks"] == 0


def test_busy_lock_skips_the_run(light):
    primary, _sarus, state = light
    state["lock"] = False
    assert schedule.run_winteam_light(NOW) == {"status": "busy"}
    assert primary.calls == [] and state["rebuilds"] == []


def test_no_rebuild_when_every_resource_was_skipped(light):
    primary, sarus, state = light
    primary.statuses = sarus.statuses = {"jobs": "skipped", "timekeeping": "skipped"}
    schedule.run_winteam_light(NOW)
    assert state["rebuilds"] == []


def test_one_failed_database_does_not_stop_the_other(light):
    primary, sarus, state = light
    primary.fail = True
    result = schedule.run_winteam_light(NOW)
    assert result["status"] == "failed" and "winteam: gateway down" in result["errors"][0]
    assert len(sarus.calls) == 1 and state["rebuilds"] == ["winteam-interval"]


def test_failed_rebuild_is_reported_not_raised(light, monkeypatch):
    from app import marts

    def boom(initiated_by):
        raise RuntimeError("locks")
    monkeypatch.setattr(marts, "rebuild_all", boom)
    result = schedule.run_winteam_light(NOW)
    assert result["status"] == "failed" and result["errors"] == ["marts: locks"]


def test_database_without_timekeeping_is_not_synced(light, monkeypatch):
    primary, _sarus, _state = light
    primary.config.winteam_resources = ("jobs", "vendors")
    schedule.run_winteam_light(NOW)
    assert primary.calls == []


# ── the PhotoValidation run ──────────────────────────────────────────────────
@pytest.fixture
def pv(monkeypatch):
    from app.sources import photovalidation
    state = {"lock": True, "last": None, "pulls": 0, "configured": True}
    monkeypatch.setattr(schedule, "settings", replace(schedule.settings, pv_sync_interval_minutes=15))
    monkeypatch.setattr(photovalidation, "configured", lambda: state["configured"])
    monkeypatch.setattr(schedule, "last_started", lambda integration, resource=None: state["last"])

    def pull():
        state["pulls"] += 1
        return {"status": "succeeded"}
    monkeypatch.setattr(photovalidation, "sync", pull)

    @contextmanager
    def fake_lock(key):
        assert key == schedule.PV_SYNC_LOCK
        yield state["lock"]
    monkeypatch.setattr(schedule, "advisory_lock", fake_lock)
    return state


def test_pv_pull_runs_when_due(pv):
    assert schedule.run_photovalidation(NOW) == {"status": "succeeded"} and pv["pulls"] == 1
    pv["last"] = NOW - timedelta(minutes=5)
    assert schedule.run_photovalidation(NOW) is None and pv["pulls"] == 1


def test_pv_pull_is_off_without_configuration_or_interval(pv, monkeypatch):
    pv["configured"] = False
    assert schedule.run_photovalidation(NOW) is None
    pv["configured"] = True
    monkeypatch.setattr(schedule, "settings", replace(schedule.settings, pv_sync_interval_minutes=0))
    assert schedule.run_photovalidation(NOW) is None
    assert pv["pulls"] == 0


def test_pv_pull_failure_is_returned_not_raised(pv, monkeypatch):
    from app.sources import photovalidation

    def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(photovalidation, "sync", boom)
    assert schedule.run_photovalidation(NOW) == {"status": "failed", "error": "db down"}


def test_pv_busy_lock_skips(pv):
    pv["lock"] = False
    assert schedule.run_photovalidation(NOW) == {"status": "busy"} and pv["pulls"] == 0


def test_worker_tick_survives_a_failing_check(monkeypatch):
    from app import nightly, worker
    calls = []

    def boom():
        calls.append("nightly")
        raise RuntimeError("database gone")
    monkeypatch.setattr(nightly, "check_and_run", boom)
    monkeypatch.setattr(schedule, "run_winteam_light", lambda: calls.append("winteam"))
    monkeypatch.setattr(schedule, "run_photovalidation", lambda: calls.append("pv"))
    worker.tick()
    assert calls == ["nightly", "winteam", "pv"]
