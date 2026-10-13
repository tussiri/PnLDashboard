"""The refresh pause: no data refreshes while leadership reviews the numbers.

REFRESH_PAUSE (default "tue 06:00-12:00") lists weekly windows, comma separated, each a weekday and a
local start-end time; REFRESH_PAUSE_TIMEZONE (default America/Chicago) is the clock they are read on,
so the window follows daylight saving time. REFRESH_PAUSE=off turns the pause off.

Inside a window:
* the worker starts nothing: the nightly sync, the light WinTeam interval sync, the PhotoValidation
  pull and the reports mailbox all wait. Nothing is queued; each runs on its first check after the
  window ends, as it would after any gap.
* the Admin refresh routes (WinTeam and Sarus syncs, Relay, HrDashboard, PhotoValidation, mailbox,
  imports, the finance reference load, mart and forecast rebuilds) answer 423, unless the request
  carries override_pause=true.
Admin edits (budgets, account mappings, allocations, settings) are not refreshes and are not paused.
Relay and HrDashboard push nothing into this warehouse: both are pulled, nightly or from Admin, so
pausing those pulls pauses them.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .config import settings

DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


class RefreshPaused(RuntimeError):
    """A refresh was asked for inside a pause window."""


def window_label(window: tuple[int, int, int]) -> str:
    day, start, end = window
    return f"{DAY_NAMES[day]} {start // 60:02d}:{start % 60:02d}-{end // 60:02d}:{end % 60:02d}"


def active_until(now: datetime | None = None, windows: tuple[tuple[int, int, int], ...] | None = None,
                 tz: str | None = None) -> datetime | None:
    """The local end of the pause window `now` falls in, or None outside every window."""
    windows = settings.refresh_pause_windows if windows is None else windows
    local = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(tz or settings.refresh_pause_timezone))
    minute = local.hour * 60 + local.minute
    for day, start, end in windows:
        if local.weekday() == day and start <= minute < end:
            midnight = datetime.combine(local.date(), time(), tzinfo=local.tzinfo)
            return midnight + timedelta(minutes=end)
    return None


def paused(now: datetime | None = None) -> bool:
    return active_until(now) is not None


def message(until: datetime) -> str:
    return (f"Data refreshes are paused until {until.strftime('%H:%M')} {until.tzname()} (REFRESH_PAUSE) so the numbers "
            "hold still for the leadership meeting; nothing ran. Send override_pause=true to run it anyway.")


def check(override: bool = False, now: datetime | None = None) -> None:
    """Raise RefreshPaused inside a window, unless overridden."""
    until = None if override else active_until(now)
    if until is not None:
        raise RefreshPaused(message(until))


def status(now: datetime | None = None) -> dict[str, Any]:
    until = active_until(now)
    return {
        "enabled": bool(settings.refresh_pause_windows),
        "timezone": settings.refresh_pause_timezone,
        "windows": [window_label(w) for w in settings.refresh_pause_windows],
        "paused": until is not None,
        "until": until.isoformat() if until else None,
    }
