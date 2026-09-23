"""Freshness on /api/v1/data/freshness (app.routers.platform).

WinTeam is synced on demand only - the worker never calls it - so no resource is behind a
schedule. `_mark_overdue` therefore never calls a resource overdue, whatever its age; the age is
reported as is, and a tenant 403 is still flagged as not entitled.
"""
from app.routers.platform import _mark_overdue


def row(**kw):
    base = {"resource_name": "timekeeping", "last_status": "succeeded", "last_error": None,
            "seconds_since_last_completion": 60}
    base.update(kw)
    return base


def test_no_resource_is_overdue_without_a_schedule():
    for marked in (
        _mark_overdue(row()),
        _mark_overdue(row(seconds_since_last_completion=1_325_339)),
        _mark_overdue(row(last_status=None, seconds_since_last_completion=None)),
        _mark_overdue(row(last_status="failed", last_error="connection refused")),
    ):
        assert marked["overdue"] is None
        assert marked["overdue_after_seconds"] is None


def test_age_is_reported_unchanged():
    assert _mark_overdue(row(seconds_since_last_completion=1_325_339))["seconds_since_last_completion"] == 1_325_339


def test_not_entitled_resource_is_flagged():
    marked = _mark_overdue(row(last_status="failed", last_error="not_entitled: HTTP 403; WinTeam returned HTTP 403"))
    assert marked["not_entitled"] is True
    assert _mark_overdue(row(last_status="failed", last_error="connection refused"))["not_entitled"] is False


def test_the_worker_never_calls_winteam():
    """Syncs are on demand: the worker module imports no WinTeam client at all."""
    import inspect

    from app import worker
    source = inspect.getsource(worker)
    assert "sync_all" not in source and "from .winteam" not in source


def test_reference_stale_threshold_is_one_week():
    """The job-cost export follows the monthly close; a load older than a week is behind by at
    least one closed month, and the months it feeds show labor without revenue."""
    from app.routers.platform import REFERENCE_STALE_AFTER_SECONDS
    assert REFERENCE_STALE_AFTER_SECONDS == 7 * 86400
