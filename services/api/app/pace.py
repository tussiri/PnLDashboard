"""Month-end labor pace projection (the simpler, separate arithmetic feature).

This is NOT the governed forecasting engine. It answers "where will this month's labor land
if the rest of the month looks like what we have measured so far", for one scope at a time
(portfolio, one parent account, or one job), and it says how it got there.

Model (ported from Finance_Reporting Command.tsx pace + cfo_dashboard/pay_period.py):

- ``as_of`` = min(today, last work_date with data in the month, month end), never before
  the first of the month. ``days_elapsed`` = day-of-month of ``as_of``.
- **Day-of-week weighted projection** (primary): labor is day-shaped (a Sunday is a fraction
  of a Tuesday), so ``projected = labor_to_date x W_total / W_elapsed`` where the weights
  are the scope's own average daily labor per ISO weekday over the trailing 90 days
  strictly BEFORE the month starts (no leakage from the month being projected).
  Method label ``day_of_week_weighted``.
- **Calendar proration** (fallback and comparison): ``labor_to_date x days_in_month /
  days_elapsed``; used when the scope has no trailing profile. Always reported as
  ``projected_calendar`` so the two are comparable on one screen.
- ``budget`` = sum of ``mart.job_month.budget_labor`` for the month in scope;
  ``budget_to_date = budget x days_elapsed / days_in_month``.
- **Measured range**: the scope's own prior complete months (up to 12) are replayed through
  the calendar gauge at weekly readings (day 7/14/21/28); readings whose elapsed fraction
  is within +/-0.15 of today's give ``err = final / projected - 1``. The 10th/90th
  percentiles of those errors are applied to the projection as ``range_lo`` / ``range_hi``
  when at least 5 readings exist; otherwise the range is null. The range therefore
  includes the gauge's own calendar-day bias, honestly.
- A month is not "in progress" once ``as_of >= month_end``: the projection equals the
  actual, the method is ``none`` and ``month_complete`` is true.

Pure math lives in the top half of this module and is unit-tested without a database;
``month_pace`` is the only function that touches SQL.
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta
from typing import Any

from .common import add_months, month_end, month_start, primary_source_of
from .db import connection

LABOR_COST_BASIS_NOTES = {
    "winteam_api": "daily labor = timekeeping hours x rate (mart.v_timekeeping_effective.labor_cost; punches the API "
                   "reports without a rate are priced at the job's trailing closed-month rate, labor_cost_basis trailing_job_rate)",
    "finance_reference": "daily labor = timekeeping hours x the job's trailing closed-month average rate "
                         "(job-cost direct_labor / actual_hours; company or portfolio rate when the job has no closed history)",
}

TRAILING_PROFILE_DAYS = 90
REPLAY_MONTHS = 12
REPLAY_DAYS = (7, 14, 21, 28)      # weekly readings, like the original week-end replay
RANGE_TOLERANCE = 0.15             # +/- on the elapsed fraction
RANGE_MIN_N = 5
COMPLETE_WITHIN_DAYS = 6           # a month counts as complete when data reaches its last week

METHOD_DOW = "day_of_week_weighted"
METHOD_CALENDAR = "calendar_proration"
METHOD_NONE = "none"


# ── pure math ────────────────────────────────────────────────────────────────
def days_in_month(month: date) -> int:
    return monthrange(month.year, month.month)[1]


def resolve_as_of(month: date, today: date, last_work_date: date | None) -> date:
    """min(today, last work date in the month, month end), clamped to the month start."""
    start, end = month_start(month), month_end(month)
    candidates = [today, end]
    if last_work_date is not None:
        candidates.append(last_work_date)
    as_of = min(candidates)
    return max(as_of, start)


def dow_profile(daily: dict[date, float]) -> dict[int, float]:
    """Average labor per ISO weekday (1=Mon..7=Sun) over the days that have data."""
    sums: dict[int, float] = {}
    counts: dict[int, int] = {}
    for d, v in daily.items():
        dow = d.isoweekday()
        sums[dow] = sums.get(dow, 0.0) + float(v)
        counts[dow] = counts.get(dow, 0) + 1
    return {dow: sums[dow] / counts[dow] for dow in sums}


def weight_totals(profile: dict[int, float], month: date, as_of: date) -> tuple[float, float]:
    """(W_total, W_elapsed): sum of weekday weights over the month and over days <= as_of."""
    start, end = month_start(month), month_end(month)
    w_total = w_elapsed = 0.0
    d = start
    while d <= end:
        w = float(profile.get(d.isoweekday(), 0.0))
        w_total += w
        if d <= as_of:
            w_elapsed += w
        d += timedelta(days=1)
    return w_total, w_elapsed


def calendar_projection(value: float, days_total: int, days_elapsed: int) -> float:
    return value * days_total / days_elapsed if days_elapsed > 0 else 0.0


def project(value: float, w_total: float, w_elapsed: float,
            days_total: int, days_elapsed: int) -> tuple[float, str]:
    """Day-of-week weighted projection when a profile exists, else calendar proration.

    Returns (projected, method). ``none`` when nothing can be projected.
    """
    if w_elapsed > 0 and w_total > 0:
        return value * w_total / w_elapsed, METHOD_DOW
    if days_elapsed > 0:
        return calendar_projection(value, days_total, days_elapsed), METHOD_CALENDAR
    return 0.0, METHOD_NONE


def replay_calendar_errors(months: dict[date, dict[date, float]],
                           reading_days: tuple[int, ...] = REPLAY_DAYS) -> list[tuple[float, float]]:
    """Replay complete prior months through the calendar gauge.

    ``months`` maps month start -> {work_date: labor}. For each month and each reading day
    (before the month end) the gauge's projection from the cumulative labor is compared
    with the month's final total: ``(elapsed_fraction, final / projected - 1)``.
    """
    out: list[tuple[float, float]] = []
    for mstart, daily in months.items():
        dim = days_in_month(mstart)
        final = sum(float(v) for v in daily.values())
        if final <= 0:
            continue
        for day in reading_days:
            if day >= dim:
                break  # the final reading equals the actual by construction
            cutoff = mstart.replace(day=day)
            cum = sum(float(v) for d, v in daily.items() if d <= cutoff)
            if cum <= 0:
                continue
            proj = cum * dim / day
            out.append((day / dim, final / proj - 1.0))
    return out


def quantile(sorted_vals: list[float], q: float) -> float:
    """Inclusive empirical quantile on a pre-sorted list (same rule as the engine)."""
    if not sorted_vals:
        return 0.0
    pos = q * (len(sorted_vals) - 1)
    i = int(pos)
    frac = pos - i
    if i + 1 >= len(sorted_vals):
        return sorted_vals[-1]
    return sorted_vals[i] * (1 - frac) + sorted_vals[i + 1] * frac


def pace_range(errors: list[tuple[float, float]], elapsed_frac: float,
               tolerance: float = RANGE_TOLERANCE) -> tuple[float | None, float | None, int]:
    """(q10, q90, n) of replay errors whose elapsed fraction is within the tolerance.

    Quantiles are null when fewer than ``RANGE_MIN_N`` readings qualify.
    """
    nearby = sorted(err for frac, err in errors if abs(frac - elapsed_frac) <= tolerance)
    n = len(nearby)
    if n < RANGE_MIN_N:
        return None, None, n
    return quantile(nearby, 0.10), quantile(nearby, 0.90), n


def apply_range(projected: float, labor_to_date: float,
                q10: float | None, q90: float | None) -> tuple[float | None, float | None]:
    """Range around the projection; never below labor already spent, hi never below lo."""
    if q10 is None or q90 is None:
        return None, None
    lo = max(projected * (1 + q10), labor_to_date)
    hi = max(projected * (1 + q90), lo)
    return lo, hi


def is_complete_month(month: date, last_work_date: date | None,
                      within_days: int = COMPLETE_WITHIN_DAYS) -> bool:
    """A prior month counts as complete when its data reaches the last week of the month."""
    if last_work_date is None:
        return False
    return last_work_date >= month_end(month) - timedelta(days=within_days)


def compute_pace_row(*, scope: str, name: str, month: date, as_of: date, today: date,
                     daily_labor: dict[date, float], daily_hours: dict[date, float],
                     budget: float | None, jobs_with_labor: int, jobs_with_budget: int,
                     ) -> dict[str, Any]:
    """Assemble one contract row from daily series (pure; no SQL).

    ``daily_labor`` / ``daily_hours`` cover [month_start - 12 months, month_end].
    """
    start, end = month_start(month), month_end(month)
    dim = days_in_month(month)
    days_elapsed = as_of.day
    complete = as_of >= end

    labor_to_date = sum(v for d, v in daily_labor.items() if start <= d <= as_of)
    hours_to_date = sum(v for d, v in daily_hours.items() if start <= d <= as_of)

    profile_start = start - timedelta(days=TRAILING_PROFILE_DAYS)
    profile = dow_profile({d: v for d, v in daily_labor.items() if profile_start <= d < start})
    w_total, w_elapsed = weight_totals(profile, month, as_of)

    if complete:
        projected, method = labor_to_date, METHOD_NONE
        projected_hours = hours_to_date
        projected_calendar = labor_to_date
    else:
        projected, method = project(labor_to_date, w_total, w_elapsed, dim, days_elapsed)
        multiplier = (projected / labor_to_date) if labor_to_date > 0 else 0.0
        projected_hours = hours_to_date * multiplier if method != METHOD_NONE else hours_to_date
        projected_calendar = calendar_projection(labor_to_date, dim, days_elapsed)

    prior_start = add_months(start, -1)
    prior_month_labor = sum(v for d, v in daily_labor.items() if prior_start <= d < start)

    # measured range from this scope's own complete prior months
    range_lo = range_hi = None
    range_n = 0
    if not complete and method != METHOD_NONE:
        prior_months: dict[date, dict[date, float]] = {}
        for d, v in daily_labor.items():
            if d < start:
                prior_months.setdefault(month_start(d), {})[d] = v
        candidates = sorted(prior_months, reverse=True)[:REPLAY_MONTHS]
        replay = {
            m: prior_months[m] for m in candidates
            if is_complete_month(m, max(prior_months[m]) if prior_months[m] else None)
        }
        q10, q90, range_n = pace_range(replay_calendar_errors(replay), days_elapsed / dim)
        range_lo, range_hi = apply_range(projected, labor_to_date, q10, q90)

    budget_value = float(budget) if budget is not None and budget > 0 else None
    budget_to_date = budget_value * days_elapsed / dim if budget_value else None
    return {
        "scope": scope,
        "name": name,
        "labor_to_date": round(labor_to_date, 2),
        "hours_to_date": round(hours_to_date, 2),
        "projected_labor": round(projected, 2),
        "projected_hours": round(projected_hours, 2),
        "projection_method": method,
        "projected_calendar": round(projected_calendar, 2),
        "budget": round(budget_value, 2) if budget_value else None,
        "budget_to_date": round(budget_to_date, 2) if budget_to_date is not None else None,
        "projected_variance": round(projected - budget_value, 2) if budget_value else None,
        "pct_over": round(projected / budget_value - 1, 4) if budget_value else None,
        "prior_month_labor": round(prior_month_labor, 2),
        "range_lo": round(range_lo, 2) if range_lo is not None else None,
        "range_hi": round(range_hi, 2) if range_hi is not None else None,
        "range_n": range_n,
        "jobs_with_labor": jobs_with_labor,
        "jobs_with_budget": jobs_with_budget,
        "profile_weekdays": len(profile),
        "month_complete": complete,
    }


# ── SQL ──────────────────────────────────────────────────────────────────────
def _scope_clause(kind: str, value: str | None, alias: str) -> tuple[str, list[Any]]:
    """Scope restriction for a timekeeping (alias t) or job_month (alias jm) query."""
    if kind == "portfolio" or not value:
        return "", []
    if kind == "job":
        return f" AND {alias}.job_number = %s", [value]
    if alias == "jm":
        return " AND jm.parent_account = %s", [value]
    return (
        f" AND {alias}.job_number IN ("
        "SELECT j.job_number FROM core.dim_job j "
        "JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key "
        "WHERE pa.account_name = %s AND j.valid_to IS NULL)",
        [value],
    )


def _load_scope(cursor: Any, kind: str, value: str | None, month: date) -> dict[str, Any]:
    start, end = month_start(month), month_end(month)
    window_start = add_months(start, -REPLAY_MONTHS)
    clause, params = _scope_clause(kind, value, "t")
    cursor.execute(
        f"""
        SELECT t.work_date,
               sum(coalesce(t.labor_cost, 0)) AS labor,
               sum(coalesce(t.hours, coalesce(t.regular_hours, 0) + coalesce(t.overtime_hours, 0))) AS hours
        FROM mart.v_timekeeping_effective t
        WHERE t.work_date >= %s AND t.work_date <= %s{clause}
        GROUP BY t.work_date
        """,
        [window_start, end, *params],
    )
    daily_labor: dict[date, float] = {}
    daily_hours: dict[date, float] = {}
    for r in cursor.fetchall():
        daily_labor[r["work_date"]] = float(r["labor"] or 0)
        daily_hours[r["work_date"]] = float(r["hours"] or 0)

    cursor.execute(
        f"""
        SELECT count(DISTINCT t.job_number) AS jobs, max(t.work_date) AS last_work_date
        FROM mart.v_timekeeping_effective t
        WHERE t.work_date >= %s AND t.work_date <= %s{clause}
          AND coalesce(t.labor_cost, 0) > 0
        """,
        [start, end, *params],
    )
    row = cursor.fetchone() or {}
    jobs_with_labor = int(row.get("jobs") or 0)
    last_work_date = row.get("last_work_date")

    jm_clause, jm_params = _scope_clause(kind, value, "jm")
    cursor.execute(
        f"""
        SELECT sum(jm.budget_labor) AS budget,
               count(*) FILTER (WHERE jm.budget_labor IS NOT NULL AND jm.budget_labor > 0) AS jobs_with_budget
        FROM mart.job_month jm
        WHERE jm.month = %s{jm_clause}
        """,
        [start, *jm_params],
    )
    b = cursor.fetchone() or {}
    return {
        "daily_labor": daily_labor,
        "daily_hours": daily_hours,
        "jobs_with_labor": jobs_with_labor,
        "last_work_date": last_work_date,
        "budget": float(b["budget"]) if b.get("budget") is not None else None,
        "jobs_with_budget": int(b.get("jobs_with_budget") or 0),
    }


def _job_name(cursor: Any, job_number: str) -> str:
    cursor.execute(
        "SELECT job_name FROM core.dim_job WHERE job_number = %s AND valid_to IS NULL LIMIT 1",
        (job_number,),
    )
    row = cursor.fetchone()
    if row and row.get("job_name"):
        return f"{job_number} {row['job_name']}"
    return job_number


def month_pace(month: date | None = None, account: str | None = None,
               job_number: str | None = None, as_of: date | None = None) -> dict[str, Any]:
    """Month-end labor projection per the /labor/pace contract.

    Rows: portfolio always; the account (if given); the job (if given). ``as_of`` may be
    forced for testing/backdating; otherwise it is min(today, last work date in the month,
    month end).
    """
    today = date.today()
    with connection() as conn, conn.cursor() as cursor:
        if month is None:
            cursor.execute("SELECT max(work_date) AS last FROM mart.v_timekeeping_effective")
            row = cursor.fetchone()
            month = month_start(row["last"]) if row and row.get("last") else month_start(today)
        month = month_start(month)

        scopes: list[tuple[str, str | None, str]] = [("portfolio", None, "All jobs")]
        if account:
            scopes.append(("account", account, account))
        if job_number:
            scopes.append(("job", job_number, _job_name(cursor, job_number)))

        loaded = [(kind, value, name, _load_scope(cursor, kind, value, month))
                  for kind, value, name in scopes]
        primary_source = primary_source_of(cursor)

    # as_of is decided on the portfolio's last work date so every row shares one basis
    portfolio_last = loaded[0][3]["last_work_date"]
    resolved_as_of = as_of or resolve_as_of(month, today, portfolio_last)
    resolved_as_of = min(max(resolved_as_of, month_start(month)), month_end(month))

    rows = [
        compute_pace_row(
            scope=kind, name=name, month=month, as_of=resolved_as_of, today=today,
            daily_labor=data["daily_labor"], daily_hours=data["daily_hours"],
            budget=data["budget"], jobs_with_labor=data["jobs_with_labor"],
            jobs_with_budget=data["jobs_with_budget"],
        )
        for kind, value, name, data in loaded
    ]
    return {
        "month": month.isoformat(),
        "as_of": resolved_as_of.isoformat(),
        "days_elapsed": resolved_as_of.day,
        "days_in_month": days_in_month(month),
        "month_complete": resolved_as_of >= month_end(month),
        "method_notes": {
            METHOD_DOW: f"labor_to_date x W_total / W_elapsed; W = average daily labor per weekday "
                        f"over the {TRAILING_PROFILE_DAYS} days before the month",
            METHOD_CALENDAR: "labor_to_date x days_in_month / days_elapsed (no trailing profile)",
            "range": f"10th-90th percentile of calendar-gauge errors replayed on up to {REPLAY_MONTHS} "
                     f"prior complete months at similar depth (+/-{RANGE_TOLERANCE}); null below "
                     f"{RANGE_MIN_N} readings",
            "labor_cost_basis": LABOR_COST_BASIS_NOTES.get(primary_source, LABOR_COST_BASIS_NOTES["winteam_api"]),
        },
        "primary_source": primary_source,
        "rows": rows,
    }
