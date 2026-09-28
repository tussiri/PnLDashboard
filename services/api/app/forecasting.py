"""Site-level forecasting engine v2 ("trust layer"), ported to Northstar Facilities.

This is a faithful port of the Finance_Reporting engine (apps/api/app/forecasting.py, v2.0)
with SQLAlchemy replaced by psycopg 3 and the IO boundary re-pointed at the Northstar marts.
The pure computation (``compute_forecasts`` and its helpers) is unchanged in method; the
differences are listed under "Platform deviations" below.

Design goals (from the forecasting audit + approved Phase 2 design):

- **Deterministic** - every number is computed by this module from the marts.
- **Data gates before fitting** - only closed months are fitted; a one-sided anomaly
  tripwire excludes suspect months (partial-import class of failure) instead of fitting
  through them; sites missing from recent closes get a status (stale/inactive), not a
  forecast; recycled job numbers are split where the site identity changes (name
  discontinuity).
- **Simple candidate pool, walk-forward selection** - naive (last month), recent-level
  (median of last 3), damped robust trend (Theil-Sen slope, fixed damping 0.9). A more
  complex candidate is used only if it beats the simpler ones by >10% in a one-step
  walk-forward. Nothing here can overfit 12 points.
- **Measured uncertainty** - intervals are empirical quantiles of walk-forward errors,
  collected PER HORIZON (so bands widen with distance by measurement, not formula) and
  pooled across sites within a volatility class so a thin series still gets an honest
  band. Flat (fixed-fee) series additionally carry measured disruption statistics instead
  of a fake +/-$0 certainty claim.
- **Track record** - every historical walk-forward call is materialised in
  ``mart.forecast_track_record`` with its band and the eventual actual, so the UI can show
  the model's real performance, including measured interval coverage.
- **Provenance** - every forecast row records the input periods, the excluded periods
  (with reasons), the method-selection scores, the interval source, and the engine
  version. ``mart.forecast_run_meta`` records the run-level assumptions as data.

All published forecasts are anchored on the same latest CLOSED month, so a portfolio row
is always the sum of same-calendar-month site rows.

Platform deviations (Northstar vs Finance_Reporting):

- Periods are ``YYYYMM`` ints inside the engine (unchanged); the database stores ``date``
  months (first of month). Conversion happens only in ``shape_run`` / ``load_site_rows``.
- Inputs come from ``mart.job_month`` (revenue = AR revenueTotal by service month,
  labor_cost = timekeeping hours x rate). Metrics forecast: ``revenue``, ``gross_profit``
  and, additionally, ``labor_cost`` and ``subcontract_cost`` (same machinery; a month is a
  valid labor point when labor_cost > 0 and a valid subcontract point when
  subcontract_cost > 0). Subcontract cost by site exists only for the finance_reference
  source (job-cost P&L); for the WinTeam API source the column is zero and the metric is
  gated out everywhere.
- Each site row carries ``delivery_model`` and ``parent_account`` from ``mart.job_month``;
  they are stored on every output row's ``quality_meta`` so the API can expose them
  without extra joins.
- Closure gate: the original inferred closed months from job-cost import batches. Here a
  month is closed when ``month_end + close_lag_days < today`` (``ops.app_setting
  close_lag_days``, default 5) AND ``mart.portfolio_month.revenue > 0`` for that month.
- Outputs go to the 004-migration tables (``mart.forecast_run_meta``, ``forecast_output``,
  ``forecast_track_record``, ``forecast_accuracy``, ``forecast_series_status``). Runs are
  kept as history (newest 10) instead of replace-in-place.
- ``forecast_run_meta.assumptions`` is jsonb; the list is stored as ``{"items": [...]}``.

Seasonality remains deliberately out of scope: 12 months of history is a single cycle and
cannot support a seasonal estimate. This is stated in the run meta.
"""

from __future__ import annotations

import logging
import statistics
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Protocol, Sequence

from psycopg.types.json import Jsonb

from .common import jsonable
from .db import connection

log = logging.getLogger(__name__)

ENGINE_VERSION = "v2.0-crane"  # surfaced in the UI; "Northstar" is a retired placeholder name
TARGET_NAME = "site_monthly"
METRICS: tuple[str, ...] = ("revenue", "gross_profit", "labor_cost", "subcontract_cost")
ACCOUNT_JOB = "__ACCOUNT__"
SCOPE_JOB = "__SCOPE__"     # the same aggregate over a key-account scope instead of one account
PORTFOLIO_JOB = "__ALL__"
PORTFOLIO_NAME = "All sites (portfolio)"
KEEP_RUNS = 10              # validated runs retained as history
DEFAULT_CLOSE_LAG_DAYS = 5

HORIZON = 3                 # months ahead (display should lead with step 1)
NOMINAL_COVERAGE = 0.80     # 10th-90th percentile band
_MIN_POINTS = 4             # valid closed months required to forecast at all
_MIN_SELECT = 6             # points required before trend/selection is trusted
_PHI = 0.9                  # fixed trend damping (not tuned - no capacity to tune)
_TREND_MARGIN = 0.10        # complex candidate must beat simpler by >10% MAE
_TRIPWIRE_DROP = 0.40       # closed-month portfolio revenue drop vs trailing median
_FLAT_TOL = 0.005           # relative tolerance for "identical every month"
_POOL_MIN = 20              # min pooled errors before falling back to all-class pool
_SITE_ERRS_MIN = 6          # site's own errors needed to widen its band
_IDENTITY_MIN_SIM = 0.30    # token-set similarity below this = different business
_STALE_AFTER = 0            # data must reach the latest closed month to forecast
_INACTIVE_AFTER = 2         # >2 months behind the latest close = inactive
_MIN_TRACK_BADGE = 3        # accuracy is reported only with >= this many backtests

# Which input column gates a month as "real" for each metric (zero = data gap, not a zero).
_GATE_FIELD = {"revenue": "revenue", "gross_profit": "revenue", "labor_cost": "labor_cost",
               "subcontract_cost": "subcontract_cost"}
# Metrics that cannot be negative; their lower bound is clamped at zero.
_NONNEGATIVE = frozenset({"revenue", "labor_cost", "subcontract_cost"})


# ── period (YYYYMM integer) arithmetic ─────────────────────────────────────
def _add_months(yyyymm: int, k: int) -> int:
    year, month = divmod(yyyymm, 100)
    idx = year * 12 + (month - 1) + k
    return (idx // 12) * 100 + (idx % 12) + 1


def _month_offset(yyyymm: int, base: int) -> int:
    y, m = divmod(yyyymm, 100)
    by, bm = divmod(base, 100)
    return (y * 12 + (m - 1)) - (by * 12 + (bm - 1))


def _month_end(yyyymm: int) -> date:
    nxt = _add_months(yyyymm, 1)
    return date(nxt // 100, nxt % 100, 1) - timedelta(days=1)


def period_to_date(yyyymm: int | None) -> date | None:
    """YYYYMM -> first-of-month date (the database representation)."""
    if yyyymm is None:
        return None
    return date(yyyymm // 100, yyyymm % 100, 1)


def date_to_period(value: date) -> int:
    return value.year * 100 + value.month


# ── small stats helpers (stdlib only, deterministic) ───────────────────────
def _theil_sen(xs: list[float], ys: list[float]) -> tuple[float, float]:
    slopes = [
        (ys[j] - ys[i]) / (xs[j] - xs[i])
        for i in range(len(xs))
        for j in range(i + 1, len(xs))
        if xs[j] != xs[i]
    ]
    slope = statistics.median(slopes) if slopes else 0.0
    intercept = statistics.median([y - slope * x for x, y in zip(xs, ys)])
    return slope, intercept


def _quantile(sorted_vals: list[float], q: float) -> float:
    """Inclusive empirical quantile on a pre-sorted list."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo_i = int(pos)
    frac = pos - lo_i
    if lo_i + 1 >= len(sorted_vals):
        return sorted_vals[-1]
    return sorted_vals[lo_i] * (1 - frac) + sorted_vals[lo_i + 1] * frac


def _scale_of(values: list[float]) -> float:
    """Robust size of a series, used to normalise errors across sites."""
    return max(statistics.median([abs(v) for v in values]), 1.0)


def _is_flat(values: list[float]) -> bool:
    """True when the recent tail is the same figure every month (fixed-fee)."""
    if len(values) < _MIN_POINTS:
        return False
    tail = values[-min(6, len(values)):]
    med = statistics.median(tail)
    tol = max(abs(med) * _FLAT_TOL, 0.01)
    return all(abs(v - med) <= tol for v in tail)


def _vol_class(values: list[float]) -> str:
    if _is_flat(values):
        return "flat"
    mean = statistics.fmean(values)
    cv = statistics.pstdev(values) / max(abs(mean), 1.0)
    return "stable" if cv < 0.15 else "volatile"


def _name_similarity(a: str, b: str) -> float:
    ta = {t for t in "".join(c.lower() if c.isalnum() else " " for c in a).split() if t}
    tb = {t for t in "".join(c.lower() if c.isalnum() else " " for c in b).split() if t}
    if not ta or not tb:
        return 1.0  # can't judge - do not split on missing names
    return len(ta & tb) / len(ta | tb)


# ── candidate methods ────────────────────────────────────────────────────────
def _predict(method: str, pts: list[tuple[int, float]], h: int) -> float:
    """Forecast h calendar months after the last point, by candidate formula."""
    ys = [v for _, v in pts]
    if method in ("naive", "contract_flat"):
        return ys[-1]
    if method == "recent3":
        return statistics.median(ys[-3:]) if len(ys) >= 3 else ys[-1]
    if method == "damped_trend":
        base_p = pts[0][0]
        xs = [float(_month_offset(p, base_p)) for p, _ in pts]
        slope, intercept = _theil_sen(xs, ys)
        level = intercept + slope * xs[-1]
        damp = sum(_PHI ** i for i in range(1, h + 1))
        return level + slope * damp
    raise ValueError(f"unknown method {method}")


def _one_step_maes(pts: list[tuple[int, float]]) -> dict[str, tuple[float, int]]:
    """One-step walk-forward MAE per candidate over this fit set."""
    by_period = dict(pts)
    errs: dict[str, list[float]] = {"naive": [], "recent3": [], "damped_trend": []}
    for o in range(_MIN_POINTS, len(pts)):
        fit = pts[:o]
        actual = by_period.get(_add_months(fit[-1][0], 1))
        if actual is None:
            continue  # a gap month - not a one-step test
        for m in errs:
            errs[m].append(abs(_predict(m, fit, 1) - actual))
    return {m: (statistics.fmean(e) if e else float("inf"), len(e)) for m, e in errs.items()}


def _select_method(pts: list[tuple[int, float]]) -> tuple[str, dict]:
    """Pick the candidate for this fit set. Simpler wins unless clearly beaten (>10% MAE)."""
    ys = [v for _, v in pts]
    if _is_flat(ys):
        return "contract_flat", {"rule": "flat_tail", "candidates": {}}
    if len(pts) < _MIN_SELECT:
        return "recent3", {"rule": "too_short_to_validate_trend", "candidates": {}}
    maes = _one_step_maes(pts)
    if maes["naive"][1] < 2:
        return "recent3", {"rule": "too_few_one_step_tests", "candidates": {}}
    scores = {m: round(v[0], 2) for m, v in maes.items()}
    chosen = "naive"
    if maes["recent3"][0] < (1 - _TREND_MARGIN) * maes["naive"][0]:
        chosen = "recent3"
    simpler_best = min(maes["naive"][0], maes["recent3"][0])
    if maes["damped_trend"][0] < (1 - _TREND_MARGIN) * simpler_best:
        chosen = "damped_trend"
    return chosen, {"rule": f"walk_forward_mae_margin_{int(_TREND_MARGIN * 100)}pct",
                    "candidates": scores, "n_one_step_tests": maes["naive"][1]}


# ── data containers ──────────────────────────────────────────────────────────
@dataclass
class Series:
    job_number: str
    job_name: str
    metric: str                       # 'revenue' | 'gross_profit' | 'labor_cost' | 'subcontract_cost'
    points: list[tuple[int, float]]   # valid (closed, non-suspect, gate>0) months
    excluded: list[dict]              # [{period, reason}]
    quality: dict                     # {warning_months, total_months}
    identity: dict | None = None      # {break_period, prior_name} when split


@dataclass
class WalkForwardCall:
    job_number: str
    metric: str
    origin_period: int
    target_period: int
    horizon: int
    method: str
    point: float
    actual: float
    scale: float
    vol_class: str
    lo: float | None = None           # filled after pooling
    hi: float | None = None
    in_band: bool | None = None


# ── core computation (pure; no DB) ──────────────────────────────────────────
def compute_forecasts(
    site_rows: list[dict],
    closed_periods: list[int],
    suspect_periods: dict[int, str],
    latest_closed: int,
    metrics: Sequence[str] = METRICS,
) -> dict:
    """Full v2 computation.

    ``site_rows`` are site-month dicts with job_number, period_id (YYYYMM), job_name,
    revenue, gross_profit, labor_cost, subcontract_cost (optional), delivery_model,
    parent_account (optional) and data_quality_status. Returns the
    engine-native rows (YYYYMM periods, ``point``/``lo``/``hi`` keys); ``shape_run``
    converts them to the database contract.
    """
    metrics = tuple(metrics)
    run_id = str(uuid.uuid4())
    closed_set = set(closed_periods)

    by_job: dict[str, list[dict]] = {}
    for r in site_rows:
        by_job.setdefault(str(r["job_number"]), []).append(r)

    series_list: list[Series] = []       # gap 0 -> gets a published forecast
    stale_series: list[Series] = []      # 1-2 months behind -> naive portfolio share
    short_series: list[Series] = []      # too short to forecast, but recent ->
                                         # contributes last value to the portfolio
    status_rows: list[dict] = []

    for job, rows in sorted(by_job.items()):
        rows.sort(key=lambda r: int(r["period_id"]))

        # identity split: keep only the segment after the last name break
        break_at, prior_name = None, None
        named = [(int(r["period_id"]), (r.get("job_name") or "")) for r in rows]
        for (_p0, n0), (p1, n1) in zip(named, named[1:]):
            if n0 and n1 and _name_similarity(n0, n1) < _IDENTITY_MIN_SIM:
                break_at, prior_name = p1, n0
        if break_at is not None:
            rows = [r for r in rows if int(r["period_id"]) >= break_at]
        identity = ({"break_period": break_at, "prior_name": prior_name}
                    if break_at is not None else None)
        job_name = rows[-1].get("job_name") or job

        warn = total = 0
        for r in rows:
            total += 1
            if (r.get("data_quality_status") or "") == "warning":
                warn += 1
        quality = {"warning_months": warn, "total_months": total,
                   "delivery_model": rows[-1].get("delivery_model"),
                   "parent_account": rows[-1].get("parent_account")}

        for metric in metrics:
            gate_field = _GATE_FIELD.get(metric, metric)
            excluded: list[dict] = []
            pts: list[tuple[int, float]] = []
            for r in rows:
                p = int(r["period_id"])
                gate = float(r.get(gate_field) or 0)
                if p not in closed_set:
                    excluded.append({"period": p, "reason": "not_closed"})
                    continue
                if p in suspect_periods:
                    excluded.append({"period": p, "reason": f"suspect: {suspect_periods[p]}"})
                    continue
                if gate <= 0:
                    excluded.append({"period": p, "reason": f"zero_{gate_field}_assumed_gap"})
                    continue
                pts.append((p, float(r.get(metric) or 0)))

            s = Series(job, job_name, metric, pts, excluded, quality, identity)
            if len(pts) < _MIN_POINTS:
                recent = bool(pts) and _month_offset(latest_closed, pts[-1][0]) <= _INACTIVE_AFTER
                status_rows.append({
                    "run_id": run_id, "job_number": job, "job_name": job_name,
                    "metric": metric, "status": "insufficient_history",
                    "reason": f"{len(pts)} valid closed months (< {_MIN_POINTS})"
                              + ("; contributes its last value to the portfolio total"
                                 if recent else ""),
                    "last_valid_period": pts[-1][0] if pts else None,
                    "n_valid": len(pts),
                })
                if recent:
                    short_series.append(s)
                continue
            gap = _month_offset(latest_closed, pts[-1][0])
            if gap > _INACTIVE_AFTER:
                status_rows.append({
                    "run_id": run_id, "job_number": job, "job_name": job_name,
                    "metric": metric, "status": "inactive",
                    "reason": f"no data since {pts[-1][0]} "
                              f"(latest closed month is {latest_closed})",
                    "last_valid_period": pts[-1][0], "n_valid": len(pts),
                })
                continue
            if gap > _STALE_AFTER:
                status_rows.append({
                    "run_id": run_id, "job_number": job, "job_name": job_name,
                    "metric": metric, "status": "stale_data",
                    "reason": f"missing from the last {gap} close(s); last data "
                              f"{pts[-1][0]}. Contributes its last value to the "
                              f"portfolio total; no site forecast published.",
                    "last_valid_period": pts[-1][0], "n_valid": len(pts),
                })
                stale_series.append(s)
                continue
            series_list.append(s)

    # 2. walk-forward pass - every historical call the engine would have made.
    #    Stale series participate so their history informs the error pools.
    calls: list[WalkForwardCall] = []
    for s in series_list + stale_series:
        by_period = dict(s.points)
        for o in range(_MIN_POINTS, len(s.points)):
            fit = s.points[:o]
            method, _sel = _select_method(fit)
            scale = _scale_of([v for _, v in fit])
            cls = _vol_class([v for _, v in fit])
            for h in range(1, HORIZON + 1):
                target = _add_months(fit[-1][0], h)
                actual = by_period.get(target)
                if actual is None:
                    continue
                calls.append(WalkForwardCall(
                    s.job_number, s.metric, fit[-1][0], target, h,
                    method, _predict(method, fit, h), actual, scale, cls,
                ))

    # 3. pooled error distributions per (metric, class, horizon)
    pool: dict[tuple[str, str, int], list[float]] = {}
    pool_all: dict[tuple[str, int], list[float]] = {}
    for c in calls:
        e = (c.actual - c.point) / c.scale
        pool.setdefault((c.metric, c.vol_class, c.horizon), []).append(e)
        pool_all.setdefault((c.metric, c.horizon), []).append(e)
    for v in pool.values():
        v.sort()
    for v in pool_all.values():
        v.sort()

    q_lo = (1 - NOMINAL_COVERAGE) / 2          # 0.10
    q_hi = 1 - q_lo                            # 0.90

    def _raw_band_offsets(metric: str, cls: str, h: int) -> tuple[float, float, dict]:
        cls_pool = pool.get((metric, cls, h), [])
        if len(cls_pool) >= _POOL_MIN:
            src, label = cls_pool, f"class:{cls}"
        else:
            src, label = pool_all.get((metric, h), []), "all_sites"
        lo, hi = _quantile(src, q_lo), _quantile(src, q_hi)
        return lo, hi, {"source": label, "n_errors": len(src),
                        "q_lo": round(lo, 4), "q_hi": round(hi, 4)}

    # Precompute offsets with weak monotone widening across horizons: a further
    # month can never carry a NARROWER band than a nearer one (the model has no
    # extra information about further months; small per-horizon pools can
    # otherwise produce accidentally-inverted widths).
    offset_table: dict[tuple[str, str, int], tuple[float, float, dict]] = {}
    classes = {(m, c) for (m, c, _h) in pool} | {
        (m, c) for m in metrics for c in ("flat", "stable", "volatile")
    }
    for metric, cls in classes:
        run_lo, run_hi = 0.0, 0.0
        for h in range(1, HORIZON + 1):
            lo, hi, meta_h = _raw_band_offsets(metric, cls, h)
            widened = lo > run_lo or hi < run_hi
            run_lo, run_hi = min(lo, run_lo), max(hi, run_hi)
            if widened:
                meta_h = {**meta_h, "monotone_widened": True}
            offset_table[(metric, cls, h)] = (run_lo, run_hi, meta_h)

    def _band_offsets(metric: str, cls: str, h: int) -> tuple[float, float, dict]:
        return offset_table.get((metric, cls, h)) or _raw_band_offsets(metric, cls, h)

    # flat-series disruption stats (measured, per metric, one-step)
    disruption: dict[str, dict] = {}
    for metric in metrics:
        rels = [
            (c.actual - c.point) / abs(c.point)
            for c in calls
            if c.metric == metric and c.vol_class == "flat" and c.horizon == 1
            and abs(c.point) > 1
        ]
        changed = sorted(abs(r) for r in rels if abs(r) > 0.01)
        disruption[metric] = {
            "n_flat_calls": len(rels),
            "p_change": round(len(changed) / len(rels), 4) if rels else None,
            "median_change_pct": round(statistics.median(changed) * 100, 1) if changed else None,
            "p90_change_pct": round(_quantile(changed, 0.9) * 100, 1) if changed else None,
        }

    # 4. retro-apply final bands to the walk-forward calls -> measured coverage
    site_errs: dict[tuple[str, str, int], list[float]] = {}
    for c in calls:
        lo_off, hi_off, _meta = _band_offsets(c.metric, c.vol_class, c.horizon)
        c.lo = c.point + lo_off * c.scale
        c.hi = c.point + hi_off * c.scale
        if c.metric in _NONNEGATIVE:
            c.lo = max(c.lo, 0.0)
        c.lo, c.hi = min(c.lo, c.point), max(c.hi, c.point)
        c.in_band = c.lo <= c.actual <= c.hi
        site_errs.setdefault((c.job_number, c.metric, c.horizon), []).append(
            (c.actual - c.point) / c.scale
        )

    coverage_summary: dict[str, dict] = {}
    for metric in metrics:
        coverage_summary[metric] = {}
        for h in range(1, HORIZON + 1):
            hs = [c for c in calls if c.metric == metric and c.horizon == h]
            coverage_summary[metric][str(h)] = {
                "n": len(hs),
                "coverage": round(sum(1 for c in hs if c.in_band) / len(hs), 4) if hs else None,
            }

    # 5. final forecasts with provenance (gap-0 series only; all share basis)
    forecast_rows: list[dict] = []
    accuracy_rows: list[dict] = []
    calls_by_series: dict[tuple[str, str], list[WalkForwardCall]] = {}
    for c in calls:
        calls_by_series.setdefault((c.job_number, c.metric), []).append(c)

    for s in series_list:
        method, selection = _select_method(s.points)
        values = [v for _, v in s.points]
        cls = _vol_class(values)
        scale = _scale_of(values)
        my_calls = calls_by_series.get((s.job_number, s.metric), [])

        run_w_lo = run_w_hi = 0.0  # dollar half-widths: never narrower at further h
        for h in range(1, HORIZON + 1):
            point = _predict(method, s.points, h)
            lo_off, hi_off, band_meta = _band_offsets(s.metric, cls, h)
            lo = point + lo_off * scale
            hi = point + hi_off * scale
            own = sorted(site_errs.get((s.job_number, s.metric, h), []))
            if len(own) >= _SITE_ERRS_MIN:
                lo = min(lo, point + _quantile(own, q_lo) * scale)
                hi = max(hi, point + _quantile(own, q_hi) * scale)
                band_meta = {**band_meta, "widened_by_site_errors": len(own)}
            run_w_lo = max(run_w_lo, point - lo)
            run_w_hi = max(run_w_hi, hi - point)
            lo, hi = point - run_w_lo, point + run_w_hi
            if s.metric in _NONNEGATIVE:
                point = max(point, 0.0)
                lo = max(lo, 0.0)
            lo, hi = min(lo, point), max(hi, point)

            explanation = _explain(s, method, selection, point, lo, hi, h, band_meta,
                                   disruption.get(s.metric) if cls == "flat" else None)
            forecast_rows.append({
                "run_id": run_id,
                "job_number": s.job_number, "job_name": s.job_name, "metric": s.metric,
                "basis_period_id": latest_closed,
                "horizon_period_id": _add_months(latest_closed, h), "horizon_step": h,
                "point": round(point, 2), "lo": round(lo, 2), "hi": round(hi, 2),
                "method": method, "explanation": explanation,
                "n_history": len(s.points),
                "status": "forecast",
                "volatility_class": cls,
                "input_periods": [p for p, _ in s.points],
                "excluded_periods": s.excluded or None,
                "method_selection": selection,
                "interval": {**band_meta, "nominal": NOMINAL_COVERAGE},
                "disruption": disruption.get(s.metric) if cls == "flat" else None,
                "identity": s.identity,
                "quality": s.quality,
                "engine_version": ENGINE_VERSION,
            })

        # per-horizon measured accuracy (median APE, MASE vs naive, coverage)
        for h in range(1, HORIZON + 1):
            hs = [c for c in my_calls if c.horizon == h]
            apes = [abs(c.actual - c.point) / abs(c.actual) for c in hs if c.actual != 0]
            mae = statistics.fmean([abs(c.actual - c.point) for c in hs]) if hs else None
            naive_errs = [
                abs(c.actual - _predict("naive",
                                        [p for p in s.points if p[0] <= c.origin_period], h))
                for c in hs
            ]
            naive_mae = statistics.fmean(naive_errs) if naive_errs else None
            med_ape = round(statistics.median(apes) * 100, 1) if apes else None
            accuracy_rows.append({
                "job_number": s.job_number, "metric": s.metric, "method": method,
                "horizon_step": h,
                "mape": med_ape if len(apes) >= _MIN_TRACK_BADGE else None,
                "median_ape": med_ape,
                "mase": round(mae / naive_mae, 3) if mae is not None and naive_mae else None,
                "coverage": round(sum(1 for c in hs if c.in_band) / len(hs), 4) if hs else None,
                "n_backtests": len(hs),
                "volatility_class": cls,
                "engine_version": ENGINE_VERSION,
            })

    # 6. portfolio = sum of site forecasts + stale/short sites' last values
    portfolio = _portfolio(series_list, stale_series, short_series, calls,
                           forecast_rows, run_id, latest_closed, metrics)
    forecast_rows.extend(portfolio["forecast_rows"])
    accuracy_rows.extend(portfolio["accuracy_rows"])
    track_rows = [_track_row(c, run_id) for c in calls] + portfolio["track_rows"]

    run_meta = {
        "run_id": run_id,
        "engine_version": ENGINE_VERSION,
        "latest_closed": latest_closed,
        "horizon_months": HORIZON,
        "metrics": list(metrics),
        "dataset": {
            "closed_periods": closed_periods,
            "suspect_periods": {str(k): v for k, v in suspect_periods.items()},
            "latest_closed": latest_closed,
            "n_sites_in_mart": len(by_job),
            "n_series_forecast": len(series_list),
            "n_series_stale": len(stale_series),
            "n_series_short_contributing": len(short_series),
            "n_series_gated_out": len(status_rows),
        },
        "gates": {
            "closed_month": "month_end + close_lag_days (ops.app_setting) is before today "
                            "and mart.portfolio_month carries revenue for the month",
            "tripwire_drop_threshold": _TRIPWIRE_DROP,
            "stale_after_months_behind": _STALE_AFTER,
            "inactive_after_months_behind": _INACTIVE_AFTER,
            "min_points": _MIN_POINTS,
            "metric_gate_fields": {m: _GATE_FIELD.get(m, m) for m in metrics},
        },
        "coverage": coverage_summary,
        "disruption": disruption,
        "portfolio": portfolio["meta"],
        "assumptions": [
            "No seasonality is modelled: 12 months of history is a single cycle and "
            "cannot support a seasonal estimate. Revisit at >=24 months.",
            "Forecasts assume the current site roster: contract wins, losses and "
            "pipeline are not visible to the model.",
            "Revenue basis is the reporting mart: the WinTeam job-cost P&L (revenue and "
            "total direct costs) for months with a closed job-cost import, AR revenueTotal "
            "by service month otherwise; labor cost is job-cost direct labor for closed "
            "months and timekeeping hours x the job's trailing rate in progress. Neither "
            "is the audited income statement.",
            "Months with zero revenue (or zero labor cost / zero subcontract cost, for the "
            "labor and subcontract metrics) are treated as data gaps, not real zeros.",
            "Subcontract cost by site comes from the job-cost P&L subcontractor line "
            "(finance_reference source) and is forecast as its own metric, gated on "
            "subcontract_cost > 0 in a closed month. For the WinTeam API source AP "
            "invoices are not job-linked, so the subcontract_cost metric is empty there.",
            "Fixed-fee sites: the interval reflects billing history and the measured "
            "disruption rate of similar flat sites; contract-termination risk beyond "
            "that history is not modelled.",
            "Interval coverage is measured by re-applying final bands to historical "
            "walk-forward calls (pseudo-out-of-sample); it is honest but slightly "
            "optimistic versus a fully frozen backtest.",
            f"Forecasts are anchored on the last CLOSED month ({latest_closed}); "
            "close lag means 'next month' can be several weeks from today.",
        ],
    }

    return {
        "run_id": run_id,
        "forecast_rows": forecast_rows,
        "accuracy_rows": accuracy_rows,
        "track_rows": track_rows,
        "status_rows": status_rows,
        "run_meta": run_meta,
    }


def _track_row(c: WalkForwardCall, run_id: str) -> dict:
    return {
        "run_id": run_id, "job_number": c.job_number, "metric": c.metric,
        "origin_period_id": c.origin_period, "target_period_id": c.target_period,
        "horizon_step": c.horizon, "method": c.method,
        "point": round(c.point, 2), "lo": round(c.lo, 2), "hi": round(c.hi, 2),
        "actual": round(c.actual, 2),
        "scaled_err": round((c.actual - c.point) / c.scale, 4),
        "in_band": c.in_band,
        "volatility_class": c.vol_class,
    }


def _explain(s: Series, method: str, selection: dict, point: float,
             lo: float, hi: float, h: int, band_meta: dict,
             disrupt: dict | None) -> str:
    label = s.metric.replace("_", " ")
    band_src = ("this site's and comparable sites'"
                if band_meta.get("widened_by_site_errors") else "comparable sites'")
    band_txt = (f"80% range {lo:,.0f} to {hi:,.0f}, from {band_meta['n_errors']} measured "
                f"{h}-month-ahead errors ({band_src} backtests).")
    if method == "contract_flat":
        base = (f"{label}: billed {point:,.0f} essentially unchanged over the recent "
                f"closed months; assumes contract terms unchanged.")
        if disrupt and disrupt.get("p_change") is not None:
            base += (f" Historically-flat sites changed in a given month "
                     f"{disrupt['p_change'] * 100:.0f}% of the time"
                     + (f", typically by about {disrupt['median_change_pct']:.0f}%."
                        if disrupt.get("median_change_pct") is not None else "."))
        return base + " " + band_txt
    if method == "naive":
        return (f"{label}: last closed month carried forward ({point:,.0f}); no candidate "
                f"beat naive in walk-forward backtests. " + band_txt)
    if method == "recent3":
        why = selection.get("rule", "")
        why_txt = ("history too short to validate a trend"
                   if "too_short" in why or "too_few" in why
                   else "more stable than naive or trend in backtests")
        return f"{label}: median of the last 3 closed months ({point:,.0f}); {why_txt}. " + band_txt
    if method == "damped_trend":
        cands = selection.get("candidates", {})
        return (f"{label}: damped robust trend (Theil-Sen, damping {_PHI}) gives {point:,.0f} "
                f"at month +{h}; trend beat naive/recent in walk-forward MAE "
                f"{cands}. " + band_txt)
    return f"{label}: {point:,.0f}. " + band_txt


def _portfolio(series_list: list[Series], stale_series: list[Series],
               short_series: list[Series],
               calls: list[WalkForwardCall], site_forecast_rows: list[dict],
               run_id: str, latest_closed: int, metrics: Sequence[str]) -> dict:
    """Portfolio = sum of site forecasts (+ stale and short-history sites' last
    values), backtested the same way: at each origin, sum the calls the engine
    would have made and compare with the actual total."""
    all_series = series_list + stale_series + short_series
    totals: dict[tuple[str, int], float] = {}
    for s in all_series:
        for p, v in s.points:
            totals[(s.metric, p)] = totals.get((s.metric, p), 0.0) + v

    grouped: dict[tuple[str, int, int], list[WalkForwardCall]] = {}
    for c in calls:
        grouped.setdefault((c.metric, c.origin_period, c.horizon), []).append(c)

    def _last_value_at(s: Series, origin: int) -> float | None:
        """Site's last value as of origin, if it was recent enough to count."""
        pts = [p for p in s.points if p[0] <= origin]
        if not pts:
            return None
        if _month_offset(origin, pts[-1][0]) > _INACTIVE_AFTER:
            return None  # would have been 'inactive' at that origin
        return pts[-1][1]

    port_calls: list[dict] = []
    port_errs: dict[tuple[str, int], list[float]] = {}
    for (metric, origin, h), cs in sorted(grouped.items()):
        target = _add_months(origin, h)
        actual_total = totals.get((metric, target))
        if actual_total is None:
            continue
        covered = {c.job_number for c in cs}
        fill = sum(
            v for s in all_series
            if s.metric == metric and s.job_number not in covered
            and (v := _last_value_at(s, origin)) is not None
        )
        pred = sum(c.point for c in cs) + fill
        port_calls.append({"metric": metric, "origin": origin, "horizon": h,
                           "point": pred, "actual": actual_total})
        port_errs.setdefault((metric, h), []).append(
            (actual_total - pred) / max(abs(actual_total), 1.0)
        )

    forecast_rows: list[dict] = []
    accuracy_rows: list[dict] = []
    track_rows: list[dict] = []
    meta: dict[str, dict] = {}

    for metric in metrics:
        sums = {h: 0.0 for h in range(1, HORIZON + 1)}
        for r in site_forecast_rows:
            if r["metric"] == metric and r["job_number"] != PORTFOLIO_JOB:
                sums[r["horizon_step"]] += r["point"]
        carried = stale_series + short_series
        stale_total = sum(s.points[-1][1] for s in carried if s.metric == metric)
        n_stale = sum(1 for s in carried if s.metric == metric)

        tot_pts = sorted((p, v) for (m, p), v in totals.items() if m == metric)
        if not tot_pts and not any(s.metric == metric for s in series_list):
            meta[metric] = {"challenger_damped_trend_h1": None, "gap_pct": None,
                            "n_stale_or_short_sites": 0, "stale_or_short_total": 0.0,
                            "published": False}
            continue  # nothing at all for this metric: no portfolio row
        challenger = (_predict("damped_trend", tot_pts, 1)
                      if len(tot_pts) >= _MIN_SELECT else None)
        gap_pct = (round((sums[1] + stale_total - challenger) / challenger * 100, 1)
                   if challenger else None)

        run_w_lo = run_w_hi = 0.0  # dollar half-widths: never narrower at further h
        for h in range(1, HORIZON + 1):
            errs = sorted(port_errs.get((metric, h), []))
            n = len(errs)
            # with <10 measured errors, use the full observed range - honest
            # about small n rather than pretending a smooth quantile exists
            if n >= 10:
                lo_off, hi_off, src = _quantile(errs, 0.10), _quantile(errs, 0.90), "quantile"
            elif n > 0:
                lo_off, hi_off, src = errs[0], errs[-1], "min_max_of_observed"
            else:
                lo_off = hi_off = 0.0
                src = "no_backtests"
            point = sums[h] + stale_total
            run_w_lo = max(run_w_lo, -lo_off * abs(point), 0.0)
            run_w_hi = max(run_w_hi, hi_off * abs(point), 0.0)
            lo, hi = point - run_w_lo, point + run_w_hi
            lo, hi = min(lo, point), max(hi, point)
            if metric in _NONNEGATIVE:
                lo = max(lo, 0.0)
            apes = [abs(pc["actual"] - pc["point"]) / abs(pc["actual"])
                    for pc in port_calls
                    if pc["metric"] == metric and pc["horizon"] == h and pc["actual"]]
            label = metric.replace("_", " ")
            stale_txt = (f" Includes {n_stale} stale/short-history site(s) at their "
                         f"last value ({stale_total:,.0f})." if n_stale else "")
            med_ape = round(statistics.median(apes) * 100, 1) if apes else None
            forecast_rows.append({
                "run_id": run_id, "job_number": PORTFOLIO_JOB,
                "job_name": PORTFOLIO_NAME, "metric": metric,
                "basis_period_id": latest_closed,
                "horizon_period_id": _add_months(latest_closed, h), "horizon_step": h,
                "point": round(point, 2), "lo": round(lo, 2), "hi": round(hi, 2),
                "method": "sum_of_site_forecasts",
                "explanation": (
                    f"{label}: sum of every active site's forecast ({point:,.0f}); "
                    f"range from {n} measured portfolio-level {h}-month backtest errors "
                    f"({src}). Assumes the current site roster; wins/losses not "
                    f"modelled.{stale_txt}"
                ),
                "n_history": len(tot_pts),
                "status": "forecast", "volatility_class": None,
                "input_periods": [p for p, _ in tot_pts],
                "excluded_periods": None,
                "method_selection": {"rule": "bottom_up_sum",
                                     "challenger_damped_trend_h1":
                                         round(challenger, 2) if challenger else None,
                                     "challenger_gap_pct": gap_pct},
                "interval": {"source": src, "n_errors": n, "nominal": NOMINAL_COVERAGE},
                "disruption": None, "identity": None,
                "quality": {"n_stale_sites": n_stale, "stale_total": round(stale_total, 2)}
                           if n_stale else None,
                "engine_version": ENGINE_VERSION,
            })
            accuracy_rows.append({
                "job_number": PORTFOLIO_JOB, "metric": metric,
                "method": "sum_of_site_forecasts", "horizon_step": h,
                "mape": med_ape if len(apes) >= _MIN_TRACK_BADGE else None,
                "median_ape": med_ape,
                "mase": None,
                # portfolio bands are built FROM these same errors; a self-coverage
                # number would be circular, so none is claimed
                "coverage": None,
                "n_backtests": n, "volatility_class": None,
                "engine_version": ENGINE_VERSION,
            })
        for pc in port_calls:
            if pc["metric"] != metric:
                continue
            track_rows.append({
                "run_id": run_id, "job_number": PORTFOLIO_JOB, "metric": metric,
                "origin_period_id": pc["origin"],
                "target_period_id": _add_months(pc["origin"], pc["horizon"]),
                "horizon_step": pc["horizon"], "method": "sum_of_site_forecasts",
                "point": round(pc["point"], 2), "lo": None, "hi": None,
                "actual": round(pc["actual"], 2),
                "scaled_err": round((pc["actual"] - pc["point"]) / max(abs(pc["actual"]), 1.0), 4),
                "in_band": None,
                "volatility_class": None,
            })
        meta[metric] = {
            "challenger_damped_trend_h1": round(challenger, 2) if challenger else None,
            "gap_pct": gap_pct,
            "n_stale_or_short_sites": n_stale,
            "stale_or_short_total": round(stale_total, 2),
            "published": True,
        }

    return {"forecast_rows": forecast_rows, "accuracy_rows": accuracy_rows,
            "track_rows": track_rows, "meta": meta}


# ── gates ────────────────────────────────────────────────────────────────────
def closed_periods_from_months(
    months_with_revenue: Iterable[date],
    today: date | None = None,
    close_lag_days: int = DEFAULT_CLOSE_LAG_DAYS,
) -> list[int]:
    """Pure closure rule: a month is closed when ``month_end + close_lag_days < today``.

    ``months_with_revenue`` must already be restricted to months whose portfolio revenue
    is > 0 (a month with no billing at all is not a close, it is an empty month).
    """
    today = today or date.today()
    lag = timedelta(days=max(int(close_lag_days), 0))
    closed: set[int] = set()
    for m in months_with_revenue:
        pid = date_to_period(m)
        if _month_end(pid) + lag < today:
            closed.add(pid)
    return sorted(closed)


class _Cursor(Protocol):
    def execute(self, query: str, params: Any = None) -> Any: ...
    def fetchone(self) -> Any: ...
    def fetchall(self) -> Any: ...


def _close_lag_days(cursor: _Cursor) -> int:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", ("close_lag_days",))
    row = cursor.fetchone()
    if not row:
        return DEFAULT_CLOSE_LAG_DAYS
    try:
        return int(row["value"])
    except (TypeError, ValueError):
        return DEFAULT_CLOSE_LAG_DAYS


def detect_closed_periods(cursor: _Cursor, today: date | None = None) -> list[int]:
    """Closed months: ``mart.portfolio_month`` months with revenue > 0 whose month end plus
    ``close_lag_days`` (ops.app_setting, default 5) is before today."""
    lag = _close_lag_days(cursor)
    cursor.execute("SELECT month FROM mart.portfolio_month WHERE revenue > 0 ORDER BY month")
    months = [r["month"] for r in cursor.fetchall()]
    return closed_periods_from_months(months, today, lag)


def detect_suspect_periods(
    period_revenue: list[tuple[int, float, int]],
) -> dict[int, str]:
    """One-sided tripwire on CLOSED months: portfolio revenue (or reporting-site
    count) dropping >40% below the trailing median of accepted months marks the
    month suspect - the partial-import signature. Upward moves are kept
    (site onboarding ramps are real growth here)."""
    suspects: dict[int, str] = {}
    accepted: list[tuple[float, int]] = []
    for pid, rev, n_sites in sorted(period_revenue):
        if len(accepted) >= 3:
            med_rev = statistics.median([a[0] for a in accepted[-3:]])
            med_sites = statistics.median([float(a[1]) for a in accepted[-3:]])
            if rev < (1 - _TRIPWIRE_DROP) * med_rev:
                suspects[pid] = (f"portfolio revenue {rev:,.0f} is "
                                 f"{(1 - rev / med_rev) * 100:.0f}% below the trailing "
                                 f"median {med_rev:,.0f} - likely partial/mis-filed import")
                continue
            if n_sites < (1 - _TRIPWIRE_DROP) * med_sites:
                suspects[pid] = (f"only {n_sites} sites reported vs trailing median "
                                 f"{med_sites:.0f} - likely partial import")
                continue
        accepted.append((rev, n_sites))
    return suspects


def suspects_for(site_rows: list[dict], closed: list[int]) -> dict[int, str]:
    """Run the tripwire over closed months using site-month totals and site counts."""
    closed_set = set(closed)
    per_period: dict[int, tuple[float, int]] = {}
    for r in site_rows:
        pid = int(r["period_id"])
        if pid in closed_set:
            rev, n = per_period.get(pid, (0.0, 0))
            per_period[pid] = (rev + float(r["revenue"] or 0), n + 1)
    return detect_suspect_periods([(pid, rev, n) for pid, (rev, n) in per_period.items()])


# ── IO: load, shape, write ───────────────────────────────────────────────────
def load_site_rows(cursor: _Cursor) -> list[dict]:
    """``mart.job_month`` -> engine input rows (YYYYMM ``period_id``, floats)."""
    cursor.execute(
        """
        SELECT job_number, month, job_name, revenue, gross_profit, labor_cost, hours,
               subcontract_cost, delivery_model, parent_account, data_quality_status
        FROM mart.job_month
        WHERE job_number IS NOT NULL
        ORDER BY job_number, month
        """
    )
    rows: list[dict] = []
    for r in cursor.fetchall():
        rows.append({
            "job_number": str(r["job_number"]),
            "period_id": date_to_period(r["month"]),
            "job_name": r.get("job_name"),
            "revenue": float(r.get("revenue") or 0),
            "gross_profit": float(r.get("gross_profit") or 0),
            "labor_cost": float(r.get("labor_cost") or 0),
            "hours": float(r.get("hours") or 0),
            "subcontract_cost": float(r.get("subcontract_cost") or 0),
            "delivery_model": r.get("delivery_model"),
            "parent_account": r.get("parent_account"),
            "data_quality_status": r.get("data_quality_status"),
        })
    return rows


def load_job_keys(cursor: _Cursor) -> dict[str, int]:
    cursor.execute("SELECT job_number, job_key FROM core.dim_job WHERE valid_to IS NULL AND job_number IS NOT NULL")
    return {str(r["job_number"]): int(r["job_key"]) for r in cursor.fetchall()}


def _iso_periods(periods: Iterable[int] | None) -> list[str]:
    return [period_to_date(p).isoformat() for p in (periods or [])]


def shape_run(result: dict, job_keys: dict[str, int], initiated_by: str) -> dict[str, Any]:
    """Map engine-native rows (YYYYMM ints, point/lo/hi) to the 004 database contract.

    Pure: returns plain dicts whose keys are the target columns. json columns hold python
    lists/dicts (wrapped as Jsonb only in ``write_run``). ``job_key`` is the current
    ``core.dim_job`` key for the job number, or None (portfolio row, unknown job).
    """
    m = result["run_meta"]
    run_id = result["run_id"]
    run_meta = {
        "forecast_run_id": run_id,
        "engine_version": m["engine_version"],
        "code_version": m["engine_version"],
        "target_name": TARGET_NAME,
        "horizon_months": m["horizon_months"],
        "latest_closed_month": period_to_date(m["latest_closed"]),
        "initiated_by": initiated_by,
        "assumptions": {"items": m["assumptions"]},
        "dataset": {
            **m["dataset"],
            "closed_periods": _iso_periods(m["dataset"]["closed_periods"]),
            "suspect_periods": {period_to_date(int(k)).isoformat(): v
                                for k, v in m["dataset"]["suspect_periods"].items()},
            "latest_closed": period_to_date(m["latest_closed"]).isoformat(),
        },
        "gates": m["gates"],
        "coverage": m["coverage"],
        "disruption": m["disruption"],
        "portfolio": m["portfolio"],
        "metrics": list(m["metrics"]),
    }

    outputs = []
    for r in result["forecast_rows"]:
        outputs.append({
            "forecast_run_id": run_id,
            "job_key": job_keys.get(r["job_number"]) if r["job_number"] != PORTFOLIO_JOB else None,
            "job_number": r["job_number"],
            "job_name": r["job_name"],
            "metric": r["metric"],
            "basis_month": period_to_date(r["basis_period_id"]),
            "forecast_month": period_to_date(r["horizon_period_id"]),
            "horizon_step": r["horizon_step"],
            "point_forecast": r["point"],
            "lower_bound": r["lo"],
            "upper_bound": r["hi"],
            "selected_model": r["method"],
            "explanation": r["explanation"],
            "n_history": r["n_history"],
            "status": r["status"],
            "volatility_class": r["volatility_class"],
            "model_scores": r["method_selection"] or {},
            "input_periods": _iso_periods(r["input_periods"]),
            "excluded_periods": [
                {"month": period_to_date(e["period"]).isoformat(), "reason": e["reason"]}
                for e in (r["excluded_periods"] or [])
            ],
            "interval_source": (r["interval"] or {}).get("source"),
            "feature_snapshot": r["interval"] or {},
            "disruption": r["disruption"],
            "identity_meta": (
                {**r["identity"], "break_month": period_to_date(r["identity"]["break_period"]).isoformat()}
                if r["identity"] else None
            ),
            "quality_meta": r["quality"],
            "engine_version": r["engine_version"],
        })

    track = []
    for t in result["track_rows"]:
        track.append({
            "forecast_run_id": run_id,
            "job_key": job_keys.get(t["job_number"]) if t["job_number"] != PORTFOLIO_JOB else None,
            "job_number": t["job_number"],
            "metric": t["metric"],
            "origin_month": period_to_date(t["origin_period_id"]),
            "forecast_month": period_to_date(t["target_period_id"]),
            "horizon": t["horizon_step"],
            "method": t["method"],
            "point_forecast": t["point"],
            "lower_bound": t["lo"],
            "upper_bound": t["hi"],
            "actual_value": t["actual"],
            "absolute_error": round(abs(t["actual"] - t["point"]), 2),
            "scaled_error": t["scaled_err"],
            "interval_hit": t["in_band"],
            "volatility_class": t.get("volatility_class"),
        })

    accuracy = [{
        "forecast_run_id": run_id,
        "job_number": a["job_number"],
        "metric": a["metric"],
        "horizon_step": a["horizon_step"],
        "method": a["method"],
        "n_backtests": a["n_backtests"],
        "median_ape": a["median_ape"],
        "mape": a["mape"],
        "mase": a["mase"],
        "coverage": a["coverage"],
        "volatility_class": a["volatility_class"],
        "engine_version": a["engine_version"],
    } for a in result["accuracy_rows"]]

    status = [{
        "forecast_run_id": run_id,
        "job_number": s["job_number"],
        "job_name": s["job_name"],
        "metric": s["metric"],
        "status": s["status"],
        "reason": s["reason"],
        "last_valid_month": period_to_date(s["last_valid_period"]),
        "n_valid": s["n_valid"],
    } for s in result["status_rows"]]

    return {"run_meta": run_meta, "outputs": outputs, "track": track,
            "accuracy": accuracy, "status": status}


_JSON_COLUMNS = frozenset({
    "assumptions", "dataset", "gates", "disruption", "portfolio",
    "model_scores", "input_periods", "excluded_periods", "feature_snapshot",
    "identity_meta", "quality_meta",
})
# `coverage` is a jsonb section on run meta but a numeric ratio on accuracy rows.
_JSON_COLUMNS_BY_TABLE = {
    "mart.forecast_run_meta": _JSON_COLUMNS | {"coverage"},
}


def _params(row: dict[str, Any], json_columns: frozenset[str] = _JSON_COLUMNS) -> dict[str, Any]:
    """Wrap json columns for psycopg; leave everything else as-is."""
    out: dict[str, Any] = {}
    for k, v in row.items():
        if k in json_columns:
            out[k] = Jsonb(jsonable(v)) if v is not None else None
        else:
            out[k] = v
    return out


def _insert(cursor: _Cursor, table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    cols = list(rows[0].keys())
    sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES "
           f"({', '.join('%(' + c + ')s' for c in cols)})")
    json_columns = _JSON_COLUMNS_BY_TABLE.get(table, _JSON_COLUMNS)
    for row in rows:
        cursor.execute(sql, _params(row, json_columns))


def write_run(cursor: _Cursor, shaped: dict[str, Any]) -> None:
    """Insert a shaped run: meta first as 'running', then rows, then mark validated.

    The caller owns the transaction; nothing here commits.
    """
    meta = shaped["run_meta"]
    _insert(cursor, "mart.forecast_run_meta", [{**meta, "status": "running"}])
    _insert(cursor, "mart.forecast_output", shaped["outputs"])
    _insert(cursor, "mart.forecast_track_record", shaped["track"])
    _insert(cursor, "mart.forecast_accuracy", shaped["accuracy"])
    _insert(cursor, "mart.forecast_series_status", shaped["status"])
    cursor.execute(
        "UPDATE mart.forecast_run_meta SET status = 'validated', training_completed_at = %s "
        "WHERE forecast_run_id = %s",
        (datetime.now(timezone.utc), meta["forecast_run_id"]),
    )


def prune_runs(cursor: _Cursor, keep: int = KEEP_RUNS) -> int:
    """Delete forecast runs older than the newest ``keep`` (forecast tables only)."""
    cursor.execute(
        """
        SELECT forecast_run_id FROM mart.forecast_run_meta
        ORDER BY created_at DESC, training_completed_at DESC NULLS LAST
        OFFSET %s
        """,
        (keep,),
    )
    old = [r["forecast_run_id"] for r in cursor.fetchall()]
    if not old:
        return 0
    for table in ("mart.forecast_output", "mart.forecast_track_record",
                  "mart.forecast_accuracy", "mart.forecast_series_status",
                  "mart.forecast_run_meta"):
        cursor.execute(f"DELETE FROM {table} WHERE forecast_run_id = ANY(%s)", (old,))
    return len(old)


def _empty_result() -> dict[str, Any]:
    return {"run_id": None, "forecast_rows": 0, "accuracy_rows": 0,
            "track_rows": 0, "status_rows": 0, "sites_forecast": 0}


def build_forecasts(initiated_by: str = "scheduled-rebuild",
                    metrics: Sequence[str] = METRICS,
                    today: date | None = None) -> dict[str, Any]:
    """Recompute site + portfolio forecasts and write a new validated run.

    One transaction: run meta ('running') -> rows -> status 'validated'. Older runs stay
    as history; runs beyond the newest ``KEEP_RUNS`` are pruned. Source data in core/mart
    is never modified. Returns zeros with ``run_id`` None when nothing is fittable.
    """
    with connection() as conn, conn.cursor() as cursor:
        closed = detect_closed_periods(cursor, today)
        site_rows = load_site_rows(cursor)
        if not site_rows or not closed:
            log.info("forecast build skipped: %d site rows, %d closed months", len(site_rows), len(closed))
            return _empty_result()
        suspects = suspects_for(site_rows, closed)
        fittable = [p for p in closed if p not in suspects]
        if not fittable:
            return _empty_result()
        latest_closed = max(fittable)

        result = compute_forecasts(site_rows, closed, suspects, latest_closed, metrics)
        shaped = shape_run(result, load_job_keys(cursor), initiated_by)
        write_run(cursor, shaped)
        pruned = prune_runs(cursor)
        conn.commit()

    log.info("forecast run %s written: %d rows, %d old runs pruned",
             result["run_id"], len(result["forecast_rows"]), pruned)
    return {
        "run_id": result["run_id"],
        "forecast_rows": len(result["forecast_rows"]),
        "accuracy_rows": len(result["accuracy_rows"]),
        "track_rows": len(result["track_rows"]),
        "status_rows": len(result["status_rows"]),
        "sites_forecast": len({r["job_number"] for r in result["forecast_rows"]
                               if r["job_number"] != PORTFOLIO_JOB}),
    }


# ── history for the UI (same series the engine fitted) ───────────────────────
def portfolio_history(metric: str = "revenue", account: str | None = None,
                      today: date | None = None) -> list[dict[str, Any]]:
    """Monthly history with the closed/suspect flags the engine applied.

    Portfolio scope reads ``mart.portfolio_month``; an account scope sums that account's
    ``mart.job_month`` rows. Closure and suspect flags are always evaluated on the
    portfolio (the engine's gates are portfolio-level), so an account view shows the same
    excluded months the site forecasts excluded. ``metric`` is accepted for symmetry with
    the routes; every metric column is returned.
    """
    with connection() as conn, conn.cursor() as cursor:
        closed = detect_closed_periods(cursor, today)
        site_rows = load_site_rows(cursor)
        suspects = suspects_for(site_rows, closed)
        if account:
            cursor.execute(
                """
                SELECT month, sum(revenue) AS revenue, sum(gross_profit) AS gross_profit,
                       sum(labor_cost) AS labor_cost, sum(hours) AS hours,
                       sum(subcontract_cost) AS subcontract_cost,
                       count(*) AS jobs_reporting
                FROM mart.job_month WHERE parent_account = %s
                GROUP BY month ORDER BY month
                """,
                (account,),
            )
        else:
            cursor.execute(
                """
                SELECT month, revenue, gross_profit, labor_cost, hours, jobs_reporting,
                       (SELECT coalesce(sum(subcontract_cost), 0) FROM mart.job_month jm
                         WHERE jm.month = pm.month) AS subcontract_cost
                FROM mart.portfolio_month pm ORDER BY month
                """
            )
        rows = cursor.fetchall()
    closed_set = set(closed)
    out = []
    for r in rows:
        pid = date_to_period(r["month"])
        out.append({
            "month": r["month"].isoformat(),
            "revenue": float(r["revenue"] or 0),
            "gross_profit": float(r["gross_profit"] or 0),
            "labor_cost": float(r["labor_cost"] or 0),
            "hours": float(r["hours"] or 0),
            "subcontract_cost": float(r["subcontract_cost"] or 0),
            "jobs_reporting": int(r["jobs_reporting"] or 0),
            "closed": pid in closed_set,
            "suspect": suspects.get(pid),
        })
    return out


# ── account aggregation (pure; used by GET /forecasts?account=) ──────────────
def aggregate_account(
    account: str,
    metric: str,
    rows: list[dict[str, Any]],
    statuses: list[dict[str, Any]],
    last_closed: dict[str, dict[str, Any]],
    last_closed_month: str | None,
    horizon: int = HORIZON,
    *,
    aggregate_job: str = ACCOUNT_JOB,
    possessive: str | None = None,
    subject: str = "the account",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Sum an account's site forecasts into ``__ACCOUNT__`` rows and describe the coverage.

    Pure. ``rows`` are the API-shaped ForecastRow dicts for this account and metric (site rows
    only; no ``__ALL__``). ``statuses`` are the account's SeriesStatus dicts for the metric.
    ``last_closed`` is ``{job_number: {revenue, labor_cost, subcontract_cost, gross_profit,
    delivery_model}}`` for every job of the account in the last closed month (its actuals).

    ``aggregate_job`` / ``possessive`` / ``subject`` let the reporting scope reuse the identical
    arithmetic for a set of accounts: ``/forecasts?scope=key`` passes ``SCOPE_JOB``, "the key
    accounts'" and "the scope", so the row is labelled ``__SCOPE__`` and the explanation reads
    naturally. The defaults keep the single-account behaviour.

    ``forecast_coverage_pct`` is the share of the account's last-closed value of the metric's
    gate field (revenue for revenue/gross_profit, labor_cost, subcontract_cost) carried by the
    sites that actually have a forecast. A low coverage means the aggregate understates the
    account: gated-out sites (short history, stale, inactive) contribute nothing here, unlike
    the portfolio row, which carries stale/short sites at their last value.
    """
    gate_field = _GATE_FIELD.get(metric, metric)
    site_rows = [r for r in rows if r.get("job_number") not in (PORTFOLIO_JOB, ACCOUNT_JOB)]
    forecast_jobs = {str(r["job_number"]) for r in site_rows}
    not_forecast_jobs = {str(s["job_number"]) for s in statuses} - forecast_jobs

    def _f(v: Any) -> float:
        return float(v or 0)

    actual = {k: round(sum(_f(j.get(k)) for j in last_closed.values()), 2)
              for k in ("revenue", "labor_cost", "subcontract_cost", "gross_profit")}
    gate_total = sum(_f(j.get(gate_field)) for j in last_closed.values())
    gate_covered = sum(_f(j.get(gate_field)) for n, j in last_closed.items() if n in forecast_jobs)
    coverage_pct = round(gate_covered / gate_total * 100, 1) if gate_total > 0 else None

    summary = {
        "account": account,
        "metric": metric,
        "sites_total": len(last_closed),
        "sites_forecast": len(forecast_jobs),
        "sites_not_forecast": len(not_forecast_jobs),
        "self_perform_sites": sum(1 for j in last_closed.values() if j.get("delivery_model") == "self_perform"),
        "subcontracted_sites": sum(1 for j in last_closed.values() if j.get("delivery_model") == "subcontracted"),
        "last_closed_month": last_closed_month,
        "last_closed_actual": actual,
        "forecast_coverage_pct": coverage_pct,
        "coverage_basis": gate_field,
    }

    account_rows: list[dict[str, Any]] = []
    if not site_rows:
        return account_rows, summary
    engine_version = site_rows[0].get("engine_version")
    label = metric.replace("_", " ")
    owner = possessive if possessive else f"{account}'s"
    cov_txt = (f"covering {coverage_pct:.0f}% of {owner} last-closed {gate_field.replace('_', ' ')}"
               if coverage_pct is not None else "coverage of last-closed actuals unknown")
    run_w_lo = run_w_hi = 0.0
    for h in range(1, horizon + 1):
        hs = [r for r in site_rows if r.get("horizon_step") == h]
        if not hs:
            continue
        point = sum(_f(r.get("point")) for r in hs)
        lo = sum(_f(r.get("lo")) if r.get("lo") is not None else _f(r.get("point")) for r in hs)
        hi = sum(_f(r.get("hi")) if r.get("hi") is not None else _f(r.get("point")) for r in hs)
        # never narrower at a further horizon than a nearer one (same rule as site rows)
        run_w_lo = max(run_w_lo, point - lo)
        run_w_hi = max(run_w_hi, hi - point)
        lo, hi = point - run_w_lo, point + run_w_hi
        if metric in _NONNEGATIVE:
            point = max(point, 0.0)
            lo = max(lo, 0.0)
        lo, hi = min(lo, point), max(hi, point)
        n_sites = len({r["job_number"] for r in hs})
        account_rows.append({
            "job_number": aggregate_job,
            "job_name": account,
            "metric": metric,
            "basis_month": hs[0].get("basis_month"),
            "forecast_month": hs[0].get("forecast_month"),
            "horizon_step": h,
            "point": round(point, 2),
            "lo": round(lo, 2),
            "hi": round(hi, 2),
            "method": "sum_of_site_forecasts",
            "explanation": (
                f"{label}: sum of the forecasts of {n_sites} of {owner} {len(last_closed)} sites "
                f"({point:,.0f}), {cov_txt}. Sites without a forecast ({len(not_forecast_jobs)}) "
                f"contribute nothing, so this understates {subject} when coverage is low. "
                f"Range is the sum of the site bands."
            ),
            "n_history": None,
            "status": "forecast",
            "volatility_class": None,
            "input_months": [],
            "excluded_months": [],
            "method_selection": {"rule": "sum_of_account_site_forecasts", "sites_forecast": n_sites,
                                 "sites_total": len(last_closed)},
            "interval": {"source": "sum_of_site_bands", "n_sites": n_sites, "nominal": NOMINAL_COVERAGE},
            "disruption": None,
            "identity": None,
            "quality": {"sites_forecast": n_sites, "sites_total": len(last_closed),
                        "forecast_coverage_pct": coverage_pct},
            "engine_version": engine_version,
            "accuracy": None,
            "delivery_model": None,
            "parent_account": account,
        })
    return account_rows, summary
