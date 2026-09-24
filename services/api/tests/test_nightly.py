"""Pure tests of the nightly schedule (no database, no WinTeam)."""
from __future__ import annotations

from datetime import date, datetime, timezone

from app.nightly import DEFAULT_SCHEDULE, due

UTC = timezone.utc


def test_runs_once_after_the_local_run_time():
    s = dict(DEFAULT_SCHEDULE)  # 02:30 America/Chicago = 07:30 UTC in September (CDT)
    assert not due(s, None, datetime(2026, 9, 24, 7, 29, tzinfo=UTC))
    assert due(s, None, datetime(2026, 9, 24, 7, 30, tzinfo=UTC))
    assert due(s, date(2026, 9, 23), datetime(2026, 9, 24, 9, 0, tzinfo=UTC))
    assert not due(s, date(2026, 9, 24), datetime(2026, 9, 24, 9, 0, tzinfo=UTC))


def test_a_missed_night_is_not_caught_up_during_the_day():
    s = dict(DEFAULT_SCHEDULE)  # window 02:30-05:30 Chicago = 07:30-10:30 UTC
    assert not due(s, date(2026, 9, 23), datetime(2026, 9, 24, 10, 30, tzinfo=UTC))
    assert not due(s, None, datetime(2026, 9, 24, 15, 0, tzinfo=UTC))


def test_uses_the_local_date_not_utc():
    s = dict(DEFAULT_SCHEDULE)
    # 03:00 UTC on the 25th is 22:00 on the 24th in Chicago: today's run already happened.
    assert not due(s, date(2026, 9, 24), datetime(2026, 9, 25, 3, 0, tzinfo=UTC))


def test_disabled_schedule_never_runs():
    assert not due({**DEFAULT_SCHEDULE, "enabled": False}, None, datetime(2026, 9, 24, 8, 0, tzinfo=UTC))


def test_follows_the_configured_time_and_zone():
    s = {**DEFAULT_SCHEDULE, "hour": 23, "minute": 0, "timezone": "America/Los_Angeles"}
    assert not due(s, None, datetime(2026, 9, 25, 5, 59, tzinfo=UTC))  # 22:59 PDT
    assert due(s, None, datetime(2026, 9, 25, 6, 0, tzinfo=UTC))
