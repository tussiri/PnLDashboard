"""Pure tests for the month-end labor pace model (no database).

Pins: as-of resolution, day-of-week weighting vs calendar proration, the calendar-gauge
replay and its quantile range, and the assembled row for an in-progress vs complete month.
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pace import (  # noqa: E402
    METHOD_CALENDAR,
    METHOD_DOW,
    METHOD_NONE,
    RANGE_MIN_N,
    apply_range,
    calendar_projection,
    compute_pace_row,
    dow_profile,
    is_complete_month,
    pace_range,
    project,
    quantile,
    replay_calendar_errors,
    resolve_as_of,
    weight_totals,
)

SEP = date(2026, 9, 1)


def _weekday_series(start: date, end: date, weekday_value: float, weekend_value: float) -> dict[date, float]:
    out: dict[date, float] = {}
    d = start
    while d <= end:
        out[d] = weekend_value if d.isoweekday() >= 6 else weekday_value
        d += timedelta(days=1)
    return out


def test_resolve_as_of_is_min_of_today_last_work_date_and_month_end():
    assert resolve_as_of(SEP, date(2026, 9, 14), date(2026, 9, 12)) == date(2026, 9, 12)
    assert resolve_as_of(SEP, date(2026, 9, 14), date(2026, 9, 20)) == date(2026, 9, 14)
    assert resolve_as_of(SEP, date(2026, 10, 5), date(2026, 10, 3)) == date(2026, 9, 30)
    assert resolve_as_of(SEP, date(2026, 9, 14), None) == date(2026, 9, 14)
    # never before the first of the month
    assert resolve_as_of(SEP, date(2026, 8, 20), None) == date(2026, 9, 1)


def test_dow_profile_and_weights():
    profile = dow_profile(_weekday_series(date(2026, 6, 1), date(2026, 8, 31), 1000.0, 200.0))
    assert profile[2] == 1000.0 and profile[7] == 200.0
    w_total, w_elapsed = weight_totals(profile, SEP, date(2026, 9, 7))  # Sep 1-7 2026: Tue..Mon
    # September 2026: 22 weekdays, 8 weekend days
    assert abs(w_total - (22 * 1000.0 + 8 * 200.0)) < 1e-9
    # Sep 1 (Tue) .. Sep 7 (Mon): 5 weekdays + 2 weekend days
    assert abs(w_elapsed - (5 * 1000.0 + 2 * 200.0)) < 1e-9


def test_project_prefers_day_of_week_and_falls_back_to_calendar():
    labor = 5 * 1000.0 + 2 * 200.0                      # a Tue..Mon week at the profile shape
    w_total = 22 * 1000.0 + 8 * 200.0
    w_elapsed = labor
    projected, method = project(labor, w_total, w_elapsed, 30, 7)
    assert method == METHOD_DOW
    assert abs(projected - w_total) < 1e-9              # exact month at the profile's shape
    cal = calendar_projection(labor, 30, 7)
    assert abs(cal - labor * 30 / 7) < 1e-9
    assert projected != cal                              # the two gauges differ when days are shaped
    projected2, method2 = project(labor, 0.0, 0.0, 30, 7)
    assert method2 == METHOD_CALENDAR and abs(projected2 - cal) < 1e-9
    assert project(0.0, 0.0, 0.0, 30, 0) == (0.0, METHOD_NONE)


def test_replay_errors_measure_calendar_gauge_bias():
    # a flat month: the calendar gauge is exact at every reading -> zero error
    flat = {date(2026, 6, 1): {date(2026, 6, 1) + timedelta(days=i): 100.0 for i in range(30)}}
    errs = replay_calendar_errors(flat)
    assert [round(e, 9) for _, e in errs] == [0.0, 0.0, 0.0, 0.0]
    assert [round(f, 4) for f, _ in errs] == [round(7 / 30, 4), round(14 / 30, 4), round(21 / 30, 4), round(28 / 30, 4)]
    # a back-loaded month: the gauge under-projects early -> positive error
    heavy = {date(2026, 7, 1): {date(2026, 7, 1) + timedelta(days=i): (50.0 if i < 15 else 150.0) for i in range(31)}}
    errs2 = replay_calendar_errors(heavy)
    assert errs2[0][1] > 0
    # empty months contribute nothing
    assert replay_calendar_errors({date(2026, 5, 1): {}}) == []


def test_quantile_and_range_gate():
    assert quantile([], 0.5) == 0.0
    assert quantile([1.0, 2.0, 3.0], 0.5) == 2.0
    readings = [(0.45, -0.10), (0.50, -0.05), (0.47, 0.0), (0.52, 0.05), (0.55, 0.10), (0.90, 5.0)]
    q10, q90, n = pace_range(readings, 0.5)
    assert n == 5 and n >= RANGE_MIN_N
    assert q10 is not None and q90 is not None
    assert -0.10 <= q10 < 0 < q90 <= 0.10          # the far-off 0.90 reading is excluded
    q10b, q90b, nb = pace_range(readings[:4], 0.5)
    assert (q10b, q90b, nb) == (None, None, 4)


def test_apply_range_never_below_spend_and_ordered():
    assert apply_range(1000.0, 200.0, None, None) == (None, None)
    lo, hi = apply_range(1000.0, 200.0, -0.1, 0.2)
    assert (lo, hi) == (900.0, 1200.0)
    lo2, hi2 = apply_range(1000.0, 950.0, -0.1, 0.2)
    assert lo2 == 950.0                            # spent already exceeds the low end
    lo3, hi3 = apply_range(1000.0, 1500.0, -0.1, 0.2)
    assert lo3 == 1500.0 and hi3 == 1500.0         # hi never below lo


def test_is_complete_month():
    assert is_complete_month(date(2026, 6, 1), date(2026, 6, 28))
    assert not is_complete_month(date(2026, 6, 1), date(2026, 6, 15))
    assert not is_complete_month(date(2026, 6, 1), None)


def test_compute_pace_row_in_progress_month():
    history = _weekday_series(date(2025, 9, 1), date(2026, 8, 31), 1000.0, 200.0)
    current = _weekday_series(date(2026, 9, 1), date(2026, 9, 14), 1100.0, 220.0)  # 10% hotter
    daily = {**history, **current}
    hours = {d: v / 20.0 for d, v in daily.items()}
    row = compute_pace_row(
        scope="portfolio", name="All jobs", month=SEP, as_of=date(2026, 9, 14), today=date(2026, 9, 15),
        daily_labor=daily, daily_hours=hours, budget=25_000.0, jobs_with_labor=3, jobs_with_budget=3,
    )
    assert row["projection_method"] == METHOD_DOW
    assert not row["month_complete"]
    full_month_at_shape = 22 * 1100.0 + 8 * 220.0
    assert abs(row["projected_labor"] - full_month_at_shape) < 0.01
    assert abs(row["projected_hours"] - full_month_at_shape / 20.0) < 0.01
    assert abs(row["projected_calendar"] - row["labor_to_date"] * 30 / 14) < 0.01
    assert row["budget"] == 25_000.0
    assert abs(row["budget_to_date"] - 25_000.0 * 14 / 30) < 0.01
    assert abs(row["projected_variance"] - (row["projected_labor"] - 25_000.0)) < 0.01
    assert abs(row["pct_over"] - (row["projected_labor"] / 25_000.0 - 1)) < 1e-4
    assert abs(row["prior_month_labor"] - sum(v for d, v in history.items() if d.month == 8 and d.year == 2026)) < 0.01
    # 12 complete prior months replayed at weekly readings near 14/30 -> a measured range
    assert row["range_n"] >= RANGE_MIN_N
    assert row["range_lo"] is not None and row["range_hi"] is not None
    assert row["labor_to_date"] <= row["range_lo"] <= row["range_hi"]
    assert row["jobs_with_labor"] == 3 and row["jobs_with_budget"] == 3


def test_compute_pace_row_complete_month_is_actual():
    daily = _weekday_series(date(2026, 5, 1), date(2026, 8, 31), 1000.0, 200.0)
    row = compute_pace_row(
        scope="job", name="10002z", month=date(2026, 8, 1), as_of=date(2026, 8, 31), today=date(2026, 9, 15),
        daily_labor=daily, daily_hours={}, budget=None, jobs_with_labor=1, jobs_with_budget=0,
    )
    assert row["month_complete"] and row["projection_method"] == METHOD_NONE
    assert row["projected_labor"] == row["labor_to_date"] == row["projected_calendar"]
    assert row["budget"] is None and row["pct_over"] is None and row["projected_variance"] is None
    assert row["range_lo"] is None and row["range_n"] == 0


def test_compute_pace_row_without_profile_uses_calendar():
    current = {date(2026, 9, 1) + timedelta(days=i): 500.0 for i in range(10)}
    row = compute_pace_row(
        scope="account", name="Acme", month=SEP, as_of=date(2026, 9, 10), today=date(2026, 9, 11),
        daily_labor=current, daily_hours={}, budget=0.0, jobs_with_labor=1, jobs_with_budget=0,
    )
    assert row["projection_method"] == METHOD_CALENDAR
    assert abs(row["projected_labor"] - 5000.0 * 30 / 10) < 0.01
    assert row["projected_labor"] == row["projected_calendar"]
    assert row["budget"] is None                    # a zero budget is "no budget", not a 0 target
    assert row["range_n"] == 0 and row["range_lo"] is None
