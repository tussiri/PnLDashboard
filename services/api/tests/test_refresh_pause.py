"""The weekly refresh pause (app/refresh_pause.py): parsing, the Central-time window across DST, the
worker skipping its checks and the Admin refresh routes answering 423 unless overridden."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app import refresh_pause
from app.common import refresh_gate
from app.config import ConfigurationError, Settings, parse_refresh_pause

UTC = timezone.utc
TUESDAY = 1
# Tuesday 2026-10-13 is daylight time (UTC-5); Tuesday 2026-12-08 is standard time (UTC-6).
SUMMER = {"before": datetime(2026, 10, 13, 10, 59, tzinfo=UTC), "start": datetime(2026, 10, 13, 11, 0, tzinfo=UTC),
          "last": datetime(2026, 10, 13, 16, 59, tzinfo=UTC), "end": datetime(2026, 10, 13, 17, 0, tzinfo=UTC)}
WINTER = {"before": datetime(2026, 12, 8, 11, 59, tzinfo=UTC), "start": datetime(2026, 12, 8, 12, 0, tzinfo=UTC),
          "last": datetime(2026, 12, 8, 17, 59, tzinfo=UTC), "end": datetime(2026, 12, 8, 18, 0, tzinfo=UTC)}


@pytest.fixture
def tuesday_pause(monkeypatch):
    monkeypatch.setattr(refresh_pause, "settings", replace(refresh_pause.settings, refresh_pause_windows=((TUESDAY, 360, 720),),
                                                          refresh_pause_timezone="America/Chicago"))


def test_default_is_tuesday_morning_central():
    s = Settings.load({})
    assert s.refresh_pause_windows == ((TUESDAY, 6 * 60, 12 * 60),)
    assert s.refresh_pause_timezone == "America/Chicago"


def test_parse_windows():
    assert parse_refresh_pause("off") == () and parse_refresh_pause("none") == ()
    assert parse_refresh_pause("Tuesday 6:00-12:00, fri 16:30-24:00") == ((1, 360, 720), (4, 990, 1440))
    for bad in ("tue", "xyz 06:00-12:00", "tue 12:00-06:00", "tue 06:00-25:00", "tue 06:75-12:00"):
        with pytest.raises(ConfigurationError):
            parse_refresh_pause(bad)
    with pytest.raises(ConfigurationError):
        Settings.load({"REFRESH_PAUSE_TIMEZONE": "Central"})
    assert Settings.load({"REFRESH_PAUSE": "off"}).refresh_pause_windows == ()


@pytest.mark.parametrize("clock", [SUMMER, WINTER], ids=["daylight", "standard"])
def test_window_follows_central_time(tuesday_pause, clock):
    assert not refresh_pause.paused(clock["before"])
    assert refresh_pause.paused(clock["start"]) and refresh_pause.paused(clock["last"])
    assert not refresh_pause.paused(clock["end"])
    until = refresh_pause.active_until(clock["start"])
    assert until.astimezone(UTC) == clock["end"]


def test_other_days_are_not_paused(tuesday_pause):
    assert not refresh_pause.paused(datetime(2026, 10, 14, 13, 0, tzinfo=UTC))  # Wednesday 08:00 CDT
    assert not refresh_pause.paused(datetime(2026, 10, 12, 13, 0, tzinfo=UTC))  # Monday 08:00 CDT


def test_status(tuesday_pause):
    s = refresh_pause.status(SUMMER["start"])
    assert s["paused"] and s["windows"] == ["Tue 06:00-12:00"] and s["until"].startswith("2026-10-13T12:00:00-05:00")
    assert refresh_pause.status(SUMMER["end"]) == {**s, "paused": False, "until": None}


def test_off_never_pauses():
    # conftest turns the pause off for every test
    assert not refresh_pause.paused(SUMMER["start"]) and not refresh_pause.status()["enabled"]


def test_admin_gate(tuesday_pause, monkeypatch):
    inside = refresh_pause.active_until(SUMMER["start"])
    monkeypatch.setattr(refresh_pause, "active_until", lambda now=None: inside)
    with pytest.raises(HTTPException) as exc:
        refresh_gate(override_pause=False)
    assert exc.value.status_code == 423 and "12:00 CDT" in exc.value.detail
    refresh_gate(override_pause=True)  # an explicit override runs
    monkeypatch.setattr(refresh_pause, "active_until", lambda now=None: None)
    refresh_gate(override_pause=False)


def test_worker_skips_every_check_while_paused(monkeypatch):
    from app import mail_inbox, nightly, schedule, worker
    calls = []
    monkeypatch.setattr(nightly, "check_and_run", lambda: calls.append("nightly"))
    monkeypatch.setattr(schedule, "run_winteam_light", lambda: calls.append("winteam"))
    monkeypatch.setattr(schedule, "run_photovalidation", lambda: calls.append("pv"))
    monkeypatch.setattr(mail_inbox, "check_and_poll", lambda: calls.append("mail"))
    until = datetime(2026, 10, 13, 17, 0, tzinfo=UTC)
    monkeypatch.setattr(refresh_pause, "active_until", lambda now=None: until)
    worker.tick()
    assert calls == []
    monkeypatch.setattr(refresh_pause, "active_until", lambda now=None: None)
    worker.tick()
    assert calls == ["nightly", "winteam", "pv", "mail"]


def test_gated_routes():
    """Every Admin route that loads or rebuilds data carries the gate; edits do not."""
    from app.main import app
    gated = {r.path for r in app.routes if hasattr(r, "dependant") and any(d.call is refresh_gate for d in r.dependant.dependencies)}
    assert gated == {f"/api/v1{p}" for p in (
        "/integrations/finance-reference/load", "/integrations/winteam/sync/{resource}", "/integrations/winteam/sync",
        "/marts/rebuild", "/integrations/winteam/sarus/sync", "/integrations/relay/sync", "/integrations/hr/sync",
        "/integrations/photovalidation/sync", "/integrations/mail/poll", "/forecasts/rebuild", "/leadership/imports")}
