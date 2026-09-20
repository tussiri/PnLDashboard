"""Overdue detection on /api/v1/data/freshness (app.routers.platform).

A hung worker records no failure: the run rows it already wrote still say "succeeded" and nothing
new appears. Freshness therefore cannot be read off `last_status`; it has to come from the age of
the last completion, which is what `_mark_overdue` decides.
"""
from app.routers.platform import _mark_overdue, _overdue_after_seconds


def row(**kw):
    base = {"resource_name": "timekeeping", "last_status": "succeeded", "last_error": None,
            "seconds_since_last_completion": 60}
    base.update(kw)
    return base


def test_recent_success_is_not_overdue():
    assert _mark_overdue(row(), 3600)["overdue"] is False


def test_success_older_than_the_limit_is_overdue():
    """The 2026-09-10 stall: status "succeeded", last completion 15 days old."""
    marked = _mark_overdue(row(seconds_since_last_completion=1_325_339), 3600)
    assert marked["overdue"] is True
    assert marked["overdue_after_seconds"] == 3600


def test_never_run_resource_is_overdue():
    assert _mark_overdue(row(last_status=None, seconds_since_last_completion=None), 3600)["overdue"] is True


def test_not_entitled_resource_is_never_overdue():
    """job_schedules / ap_payments answer 403 for this tenant and never complete by design."""
    marked = _mark_overdue(
        row(resource_name="job_schedules", last_status="failed",
            last_error="not_entitled: HTTP 403; WinTeam returned HTTP 403",
            seconds_since_last_completion=1_325_327),
        3600,
    )
    assert marked["not_entitled"] is True
    assert marked["overdue"] is False


def test_other_failures_still_count_as_overdue():
    marked = _mark_overdue(row(last_status="failed", last_error="connection refused",
                               seconds_since_last_completion=999_999), 3600)
    assert marked["overdue"] is True


def test_limit_never_falls_below_the_floor():
    assert _overdue_after_seconds() >= 3600


def test_resource_outside_the_winteam_catalogue_is_not_judged():
    """Historical loader steps (fact_daily_budget, contract_billing) share the run table but are
    not on the worker's schedule, so they are neither fresh nor overdue."""
    marked = _mark_overdue(row(resource_name="fact_daily_budget", last_status=None,
                               seconds_since_last_completion=None), 3600)
    assert marked["overdue"] is None
    assert marked["overdue_after_seconds"] is None


def test_reference_stale_threshold_is_one_week():
    """The job-cost export follows the monthly close; a load older than a week is behind by at
    least one closed month, and the months it feeds show labor without revenue."""
    from app.routers.platform import REFERENCE_STALE_AFTER_SECONDS
    assert REFERENCE_STALE_AFTER_SECONDS == 7 * 86400
