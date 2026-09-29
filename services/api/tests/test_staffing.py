"""Pure tests of the weekly staffing-demand rule (app/staffing.py), the mirror of DEMAND_SQL."""
from __future__ import annotations

from datetime import date, datetime, timezone

from app import staffing

UTC = timezone.utc


def at(day: int, hour: int = 12) -> datetime:
    return datetime(2026, 9, day, hour, tzinfo=UTC)


def ln(status: str, n: int = 2, **ts) -> dict:
    return {"status": status, "headcount_needed": n, "submitted_at": at(1), "decided_at": None, "posted_at": None,
            "filled_at": None, "closed_at": None, **ts}


def test_current_state_matches_the_spec_definition():
    """At now, active = approved | posted and pending = submitted, whatever came before."""
    now = at(28)
    lines = [
        ln("submitted", 1),
        ln("approved", 2, decided_at=at(3)),
        ln("posted", 3, decided_at=at(3), posted_at=at(5)),
        ln("filled", 4, decided_at=at(3), posted_at=at(5), filled_at=at(20), closed_at=at(20)),
        ln("rejected", 5, decided_at=at(3), closed_at=at(3)),
        ln("cancelled", 6, closed_at=at(4)),
        ln("cancelled", 7, decided_at=at(3), closed_at=at(10)),
    ]
    assert staffing.demand_at(lines, now) == {"requested_headcount": 5, "pending_requested_headcount": 1}


def test_a_line_moves_from_pending_to_active_to_closed():
    line = ln("filled", 2, decided_at=at(5), posted_at=at(8), filled_at=at(15))
    assert staffing.state_at(line, at(1, 0)) is None          # before submission
    assert staffing.state_at(line, at(3)) == "pending"
    assert staffing.state_at(line, at(5)) == "active"         # decided: approved
    assert staffing.state_at(line, at(10)) == "active"        # posted in Hire
    assert staffing.state_at(line, at(15)) is None            # filled


def test_rejected_and_cancelled_lines():
    rejected = ln("rejected", decided_at=at(4), closed_at=at(4))
    assert staffing.state_at(rejected, at(3)) == "pending" and staffing.state_at(rejected, at(5)) is None
    withdrawn = ln("cancelled", closed_at=at(6))                     # cancelled while submitted
    assert staffing.state_at(withdrawn, at(5)) == "pending" and staffing.state_at(withdrawn, at(7)) is None
    dropped = ln("cancelled", decided_at=at(4), closed_at=at(9))     # cancelled after approval
    assert staffing.state_at(dropped, at(6)) == "active" and staffing.state_at(dropped, at(10)) is None


def test_approved_line_without_timestamps_is_active_from_submission():
    line = ln("approved")
    assert staffing.state_at(line, at(2)) == "active"
    assert staffing.line_intervals(line)[1] == at(1)  # never pending


def test_lines_without_headcount_or_submission_do_not_count():
    assert staffing.state_at(ln("submitted", 0), at(5)) is None
    assert staffing.state_at({**ln("submitted"), "submitted_at": None}, at(5)) is None


def test_week_moment_is_the_end_of_the_week_or_now():
    now = datetime(2026, 9, 29, 15, tzinfo=UTC)                     # a Tuesday
    assert staffing.week_moment(date(2026, 9, 21), now) == datetime(2026, 9, 28, tzinfo=UTC)
    assert staffing.week_moment(date(2026, 9, 28), now) == now       # the week in progress


def test_past_weeks_keep_the_demand_open_then():
    lines = [ln("filled", 3, submitted_at=at(2), decided_at=at(9), filled_at=at(24))]
    now = datetime(2026, 9, 29, 15, tzinfo=UTC)
    by_week = {w: staffing.demand_at(lines, staffing.week_moment(w, now)) for w in
               (date(2026, 8, 31), date(2026, 9, 7), date(2026, 9, 14), date(2026, 9, 21), date(2026, 9, 28))}
    assert by_week[date(2026, 8, 31)] == {"requested_headcount": 0, "pending_requested_headcount": 3}
    assert by_week[date(2026, 9, 7)]["requested_headcount"] == 3
    assert by_week[date(2026, 9, 14)]["requested_headcount"] == 3
    assert by_week[date(2026, 9, 21)] == {"requested_headcount": 0, "pending_requested_headcount": 0}


def test_days_open():
    now = at(29)
    assert staffing.days_open(ln("posted", decided_at=at(3)), now) == 28
    assert staffing.days_open(ln("filled", filled_at=at(11), closed_at=at(12)), now) == 10
    assert staffing.days_open(ln("cancelled", closed_at=at(4)), now) == 3
    assert staffing.days_open({**ln("submitted"), "submitted_at": None}, now) is None


def test_sql_mirrors_the_rule():
    sql = staffing.DEMAND_SQL
    assert "status IN ('approved', 'posted', 'filled') OR (status = 'cancelled' AND decided_at IS NOT NULL)" in sql
    assert "coalesce(decided_at, closed_at, filled_at, posted_at" in sql and "coalesce(filled_at, closed_at)" in sql
    assert "least((w.week_start + 7)::timestamp AT TIME ZONE 'UTC', now())" in sql
    # NULL (not 0) until the feed has loaded once
    assert "CASE WHEN f.loaded THEN coalesce(d.active, 0) END" in sql
    resolve = staffing.RESOLVE_JOB_KEYS_SQL
    assert "mart.v_api_job_map" in resolve and "mart.v_sarus_job_map" in resolve and "'Crane:' ||" in resolve
    assert "IS DISTINCT FROM 'Sarus'" in resolve
