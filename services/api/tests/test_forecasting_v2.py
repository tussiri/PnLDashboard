"""Deterministic unit tests for forecasting engine v2 (pure functions, no DB).

Ported from Finance_Reporting apps/api/tests/test_forecasting_v2.py. Each test pins a
behavior the forecasting audit flagged:
- flat fixed-fee series must NOT emit a bare +/-$0 certainty claim (disruption stats must
  accompany it),
- intervals must widen (weakly) with horizon,
- the tripwire must catch the partial-import signature and must NOT fire on a growth ramp,
- identity breaks (recycled job numbers) must split the series,
- method selection must not pick trend on unvalidatable history,
- stale/inactive sites must get statuses, not forecasts.

Northstar additions: the closure gate rule, and the YYYYMM -> ISO-date / column shaping
that feeds the 004 tables (exercised against a fake cursor, no database).
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.forecasting import (  # noqa: E402
    ACCOUNT_JOB,
    ENGINE_VERSION,
    HORIZON,
    METRICS,
    PORTFOLIO_JOB,
    _add_months,
    _is_flat,
    _month_offset,
    _predict,
    _quantile,
    _select_method,
    _theil_sen,
    aggregate_account,
    closed_periods_from_months,
    compute_forecasts,
    date_to_period,
    detect_suspect_periods,
    period_to_date,
    shape_run,
    write_run,
)


def _mk_rows(job, name, start, values, quality="passed", labor=None, sub=None,
             delivery_model=None, parent_account=None):
    rows = []
    p = start
    for i, v in enumerate(values):
        rows.append({
            "job_number": job, "period_id": p, "job_name": name,
            "revenue": v, "gross_profit": v * 0.3,
            "labor_cost": (labor[i] if labor is not None else 0.0),
            "subcontract_cost": (sub[i] if sub is not None else 0.0),
            "delivery_model": delivery_model, "parent_account": parent_account,
            "data_quality_status": quality,
        })
        p = _add_months(p, 1)
    return rows


CLOSED = [_add_months(202507, k) for k in range(12)]  # 202507..202606
LATEST = 202606


def test_period_math():
    assert _add_months(202512, 1) == 202601
    assert _add_months(202601, -1) == 202512
    assert _month_offset(202606, 202507) == 11
    assert period_to_date(202606) == date(2026, 6, 1)
    assert date_to_period(date(2026, 6, 1)) == 202606
    assert period_to_date(None) is None


def test_quantile_inclusive():
    assert _quantile([], 0.5) == 0.0
    assert _quantile([3.0], 0.9) == 3.0
    assert _quantile([1.0, 2.0, 3.0], 0.5) == 2.0
    assert abs(_quantile([1.0, 2.0, 3.0, 4.0], 0.9) - 3.7) < 1e-9


def test_theil_sen_recovers_line():
    xs = [0.0, 1.0, 2.0, 3.0, 4.0]
    ys = [10.0, 12.0, 14.0, 16.0, 18.0]
    slope, intercept = _theil_sen(xs, ys)
    assert abs(slope - 2.0) < 1e-9 and abs(intercept - 10.0) < 1e-9


def test_flat_detection():
    assert _is_flat([25207.0] * 12)
    assert _is_flat([25207.0, 25207.0, 25207.01, 25207.0])
    assert not _is_flat([100.0, 200.0, 300.0, 400.0])
    assert not _is_flat([25207.0] * 3)  # too short to call


def test_selection_never_trend_on_short_history():
    pts = [(_add_months(202601, i), 1000.0 * (i + 1)) for i in range(5)]
    method, sel = _select_method(pts)
    assert method == "recent3"
    assert "too_short" in sel["rule"]


def test_selection_picks_trend_only_when_clearly_better():
    # strong clean trend: damped_trend should win the walk-forward
    pts = [(_add_months(202507, i), 1000.0 + 500.0 * i) for i in range(12)]
    method, sel = _select_method(pts)
    assert method == "damped_trend"
    # noisy flat-ish series: naive/recent3 must win (no spurious trend)
    noisy = [1000.0, 1100.0, 950.0, 1050.0, 1000.0, 1080.0, 940.0, 1020.0,
             1060.0, 980.0, 1030.0, 990.0]
    pts2 = [(_add_months(202507, i), v) for i, v in enumerate(noisy)]
    method2, _ = _select_method(pts2)
    assert method2 in ("naive", "recent3")


def test_damped_trend_extrapolates_less_than_linear():
    pts = [(_add_months(202507, i), 1000.0 + 500.0 * i) for i in range(12)]
    p1 = _predict("damped_trend", pts, 1)
    p3 = _predict("damped_trend", pts, 3)
    last = 1000.0 + 500.0 * 11
    linear3 = last + 3 * 500.0
    assert p1 > last                       # still rising
    assert p3 < linear3                    # but damped below straight-line


def test_tripwire_catches_partial_month_not_growth_ramp():
    # growth ramp (the real 2025 H2 shape): no false positive
    ramp = [(CLOSED[i], 2_680_000 + 300_000 * i, 160 + 10 * i) for i in range(12)]
    assert detect_suspect_periods(ramp) == {}
    # the partial-import signature: ~58% drop vs neighbors -> caught
    may = [(CLOSED[i], 5_000_000, 250) for i in range(12)]
    may[10] = (CLOSED[10], 2_129_812, 278)
    suspects = detect_suspect_periods(may)
    assert list(suspects) == [CLOSED[10]]
    assert "below the trailing median" in suspects[CLOSED[10]]


def test_closure_gate_uses_lag_and_revenue_months():
    months = [date(2026, 5, 1), date(2026, 6, 1), date(2026, 7, 1), date(2026, 8, 1)]
    # today = Sep 4: Aug 31 + 5 days = Sep 5 is not < Sep 4 -> August is NOT closed yet
    assert closed_periods_from_months(months, today=date(2026, 9, 4), close_lag_days=5) == [202605, 202606, 202607]
    # Sep 6: August closes
    assert closed_periods_from_months(months, today=date(2026, 9, 6), close_lag_days=5) == [202605, 202606, 202607, 202608]
    # zero lag: closed the day after month end
    assert closed_periods_from_months([date(2026, 8, 1)], today=date(2026, 9, 1), close_lag_days=0) == [202608]
    assert closed_periods_from_months([date(2026, 8, 1)], today=date(2026, 8, 31), close_lag_days=0) == []


def test_end_to_end_flat_site_gets_disruption_not_bare_zero_band():
    rows = []
    # 30 flat sites, 2 of which changed once -> measurable disruption pool
    for j in range(30):
        vals = [10_000.0 + j] * 12
        if j < 2:
            vals[8] = (10_000.0 + j) * 1.2
        rows += _mk_rows(f"F{j}", f"Flat Site {j}", 202507, vals)
    out = compute_forecasts(rows, CLOSED, {}, LATEST)
    flat_rows = [r for r in out["forecast_rows"]
                 if r["metric"] == "revenue" and r["volatility_class"] == "flat"
                 and r["horizon_step"] == 1]
    assert flat_rows, "expected flat forecasts"
    for r in flat_rows:
        assert r["disruption"] is not None
        assert r["disruption"]["p_change"] is not None
        assert "unchanged" in r["explanation"]
        assert "changed in a given month" in r["explanation"]


def test_end_to_end_intervals_widen_with_horizon():
    rows = []
    for j in range(25):  # varied noisy sites so pools are populated
        base = 5_000.0 * (j + 1)
        vals = [base * (1 + 0.08 * ((i * 7 + j * 3) % 5 - 2)) for i in range(12)]
        rows += _mk_rows(f"V{j}", f"Var Site {j}", 202507, vals)
    out = compute_forecasts(rows, CLOSED, {}, LATEST)
    by_site: dict[str, dict[int, float]] = {}
    for r in out["forecast_rows"]:
        if r["metric"] == "revenue" and r["job_number"] != PORTFOLIO_JOB:
            by_site.setdefault(r["job_number"], {})[r["horizon_step"]] = r["hi"] - r["lo"]
    assert by_site
    for job, widths in by_site.items():
        assert widths[1] > 0, f"{job}: zero band on a volatile site"
        assert widths[3] >= widths[1] * 0.99, f"{job}: band narrowed with horizon"


def test_end_to_end_statuses_and_identity():
    rows = []
    rows += _mk_rows("A", "Active Site", 202507, [10_000 + 100 * i for i in range(12)])
    rows += _mk_rows("D", "Dead Site", 202507, [8_000.0] * 6)          # ends 202512
    rows += _mk_rows("S", "Stale Site", 202507, [6_000.0] * 11)        # ends 202605
    rows += _mk_rows("N", "New Site", 202604, [4_000.0] * 3)           # 3 months
    # recycled job number: FedEx then Whole Foods
    rows += _mk_rows("R", "FedEx - City of Industry", 202507, [1.0] * 8)
    rows += _mk_rows("R", "Whole Foods - CHB", 202603, [4_293.0] * 4)
    # padding sites so pools exist
    for j in range(20):
        rows += _mk_rows(f"P{j}", f"Pad {j}",
                         202507, [3_000.0 + 50 * ((i + j) % 4) for i in range(12)])

    out = compute_forecasts(rows, CLOSED, {}, LATEST)
    statuses = {(r["job_number"], r["metric"]): r["status"] for r in out["status_rows"]}
    assert statuses[("D", "revenue")] == "inactive"
    assert statuses[("S", "revenue")] == "stale_data"
    assert statuses[("N", "revenue")] == "insufficient_history"

    r_rows = [r for r in out["forecast_rows"]
              if r["job_number"] == "R" and r["metric"] == "revenue"]
    assert r_rows, "recycled job should still forecast its current identity"
    for r in r_rows:
        assert r["identity"] is not None and r["identity"]["break_period"] == 202603
        assert r["job_name"] == "Whole Foods - CHB"
        assert r["n_history"] == 4  # only the Whole Foods segment

    # every published forecast is anchored on the same basis month
    assert {r["basis_period_id"] for r in out["forecast_rows"]} == {LATEST}

    # portfolio = site points + stale S (6,000) + short-history N (4,000)
    port = {r["horizon_step"]: r for r in out["forecast_rows"]
            if r["job_number"] == PORTFOLIO_JOB and r["metric"] == "revenue"}
    site_sum = sum(r["point"] for r in out["forecast_rows"]
                   if r["metric"] == "revenue" and r["job_number"] != PORTFOLIO_JOB
                   and r["horizon_step"] == 1)
    assert abs(port[1]["point"] - (site_sum + 6_000.0 + 4_000.0)) < 1.0


def test_end_to_end_track_record_and_coverage_exist():
    rows = []
    for j in range(15):
        base = 10_000.0 * (j + 1)
        vals = [base * (1 + 0.05 * ((i + j) % 3 - 1)) for i in range(12)]
        rows += _mk_rows(f"T{j}", f"Track {j}", 202507, vals)
    out = compute_forecasts(rows, CLOSED, {}, LATEST)
    assert out["track_rows"], "walk-forward track record must exist"
    site_tracks = [t for t in out["track_rows"] if t["job_number"] != PORTFOLIO_JOB]
    assert all(t["in_band"] is not None for t in site_tracks)
    cov = out["run_meta"]["coverage"]["revenue"]
    assert cov["1"]["n"] > 0 and cov["1"]["coverage"] is not None
    # accuracy badge honesty: no mape published off fewer than 3 backtests
    for a in out["accuracy_rows"]:
        if a["n_backtests"] < 3:
            assert a["mape"] is None
    # assumptions are first-class
    assert any("seasonality" in a.lower() for a in out["run_meta"]["assumptions"])


def test_labor_cost_metric_uses_its_own_gate():
    """A month with revenue but no labor is a labor gap, not a zero labor point."""
    labor = [5_000.0 + 20 * i for i in range(12)]
    labor[4] = 0.0  # one month without timekeeping
    rows = _mk_rows("L", "Labor Site", 202507, [12_000.0] * 12, labor=labor)
    for j in range(10):  # padding so pools exist
        rows += _mk_rows(f"LP{j}", f"Labor Pad {j}", 202507, [9_000.0] * 12,
                         labor=[4_000.0 + 30 * ((i + j) % 5) for i in range(12)])
    out = compute_forecasts(rows, CLOSED, {}, LATEST)
    lab = [r for r in out["forecast_rows"] if r["job_number"] == "L" and r["metric"] == "labor_cost"]
    assert len(lab) == HORIZON
    assert lab[0]["n_history"] == 11
    assert {e["reason"] for e in lab[0]["excluded_periods"]} == {"zero_labor_cost_assumed_gap"}
    assert lab[0]["lo"] >= 0.0
    rev = [r for r in out["forecast_rows"] if r["job_number"] == "L" and r["metric"] == "revenue"]
    assert rev[0]["n_history"] == 12 and rev[0]["excluded_periods"] is None
    # a labor portfolio row exists because labor series were fitted
    assert any(r["job_number"] == PORTFOLIO_JOB and r["metric"] == "labor_cost" for r in out["forecast_rows"])


def test_subcontract_cost_metric_uses_its_own_gate():
    """Subcontract cost is forecast as its own series, gated on subcontract_cost > 0; a self-perform
    site with no subcontract line gets a status, not a zero forecast."""
    sub = [7_000.0 + 40 * i for i in range(12)]
    sub[6] = 0.0  # one closed month without a subcontractor line = gap, not a zero
    rows = _mk_rows("SC", "Subbed Site", 202507, [15_000.0] * 12, sub=sub,
                    delivery_model="subcontracted", parent_account="FedEx")
    rows += _mk_rows("SP", "Self Perform Site", 202507, [15_000.0] * 12,
                     labor=[9_000.0] * 12, delivery_model="self_perform", parent_account="FedEx")
    for j in range(10):  # padding so error pools exist
        rows += _mk_rows(f"SCP{j}", f"Sub Pad {j}", 202507, [9_000.0] * 12,
                         sub=[5_000.0 + 30 * ((i + j) % 5) for i in range(12)],
                         delivery_model="subcontracted", parent_account="Other")
    out = compute_forecasts(rows, CLOSED, {}, LATEST)
    assert "subcontract_cost" in METRICS
    sc = [r for r in out["forecast_rows"] if r["job_number"] == "SC" and r["metric"] == "subcontract_cost"]
    assert len(sc) == HORIZON
    assert sc[0]["n_history"] == 11
    assert {e["reason"] for e in sc[0]["excluded_periods"]} == {"zero_subcontract_cost_assumed_gap"}
    assert sc[0]["lo"] >= 0.0 and sc[0]["point"] > 0
    # site dims ride on quality so the API can expose them without joins
    assert sc[0]["quality"]["delivery_model"] == "subcontracted"
    assert sc[0]["quality"]["parent_account"] == "FedEx"
    # the self-perform site's subcontract series is gated out, its revenue is not
    statuses = {(r["job_number"], r["metric"]): r["status"] for r in out["status_rows"]}
    assert statuses[("SP", "subcontract_cost")] == "insufficient_history"
    assert ("SP", "revenue") not in statuses
    assert any(r["job_number"] == "SP" and r["metric"] == "revenue" for r in out["forecast_rows"])
    # portfolio row and run meta carry the metric like any other
    assert any(r["job_number"] == PORTFOLIO_JOB and r["metric"] == "subcontract_cost" for r in out["forecast_rows"])
    meta = out["run_meta"]
    assert meta["gates"]["metric_gate_fields"]["subcontract_cost"] == "subcontract_cost"
    assert meta["portfolio"]["subcontract_cost"]["published"] is True
    assert any("subcontract" in a.lower() and "job-cost" in a.lower() for a in meta["assumptions"])
    assert not any("not forecast by site" in a for a in meta["assumptions"])
    # the write path accepts the metric (no fake key, ISO months, same columns)
    shaped = shape_run(out, {}, initiated_by="unit-test")
    assert any(o["metric"] == "subcontract_cost" and o["quality_meta"]["delivery_model"] == "subcontracted"
               for o in shaped["outputs"])


def _api_row(job, h, point, lo, hi, metric="revenue"):
    return {"job_number": job, "job_name": f"Site {job}", "metric": metric, "basis_month": "2026-07-01",
            "forecast_month": f"2026-{7 + h:02d}-01", "horizon_step": h, "point": point, "lo": lo, "hi": hi,
            "method": "naive", "engine_version": ENGINE_VERSION}


def test_aggregate_account_sums_sites_and_reports_coverage():
    rows = []
    for job, base in (("A1", 100.0), ("A2", 300.0)):
        for h in (1, 2, 3):
            rows.append(_api_row(job, h, base + h, base - 10 * h, base + 20 * h))
    # a portfolio row must be ignored even if the caller forgot to strip it
    rows.append(_api_row(PORTFOLIO_JOB, 1, 999_999.0, 0.0, 1e9))
    statuses = [{"job_number": "A3", "metric": "revenue", "status": "insufficient_history"},
                {"job_number": "A4", "metric": "revenue", "status": "inactive"}]
    last_closed = {
        "A1": {"revenue": 100.0, "labor_cost": 60.0, "subcontract_cost": 0.0, "gross_profit": 40.0, "delivery_model": "self_perform"},
        "A2": {"revenue": 300.0, "labor_cost": 0.0, "subcontract_cost": 250.0, "gross_profit": 50.0, "delivery_model": "subcontracted"},
        "A3": {"revenue": 600.0, "labor_cost": 0.0, "subcontract_cost": 500.0, "gross_profit": 100.0, "delivery_model": "subcontracted"},
        "A5": {"revenue": 0.0, "labor_cost": 0.0, "subcontract_cost": 0.0, "gross_profit": 0.0, "delivery_model": None},
    }
    acct_rows, summary = aggregate_account("FedEx", "revenue", rows, statuses, last_closed, "2026-07-01")

    assert [r["horizon_step"] for r in acct_rows] == [1, 2, 3]
    r1 = acct_rows[0]
    assert r1["job_number"] == ACCOUNT_JOB and r1["job_name"] == "FedEx"
    assert r1["method"] == "sum_of_site_forecasts" and r1["parent_account"] == "FedEx"
    assert r1["point"] == 402.0 and r1["lo"] == 380.0 and r1["hi"] == 440.0
    assert r1["forecast_month"] == "2026-08-01" and r1["basis_month"] == "2026-07-01"
    assert "2 of FedEx's 4 sites" in r1["explanation"] and "40%" in r1["explanation"]
    # bands never narrow with horizon
    widths = [r["hi"] - r["lo"] for r in acct_rows]
    assert widths[0] <= widths[1] <= widths[2]
    assert acct_rows[2]["point"] == 406.0

    assert summary["sites_total"] == 4
    assert summary["sites_forecast"] == 2
    assert summary["sites_not_forecast"] == 2
    assert summary["self_perform_sites"] == 1 and summary["subcontracted_sites"] == 2
    assert summary["last_closed_month"] == "2026-07-01"
    assert summary["last_closed_actual"] == {"revenue": 1000.0, "labor_cost": 60.0,
                                             "subcontract_cost": 750.0, "gross_profit": 190.0}
    assert summary["forecast_coverage_pct"] == 40.0  # (100 + 300) / 1000
    assert summary["coverage_basis"] == "revenue"

    # subcontract metric: coverage is measured on the subcontract line
    sub_rows = [_api_row("A2", 1, 240.0, 200.0, 260.0, metric="subcontract_cost")]
    sub_acct, sub_summary = aggregate_account("FedEx", "subcontract_cost", sub_rows, [], last_closed, "2026-07-01")
    assert sub_summary["forecast_coverage_pct"] == round(250 / 750 * 100, 1)
    assert sub_acct[0]["point"] == 240.0 and sub_acct[0]["lo"] >= 0

    # nothing forecast: no rows, honest summary
    none_rows, none_summary = aggregate_account("FedEx", "revenue", [], statuses, last_closed, "2026-07-01")
    assert none_rows == [] and none_summary["sites_forecast"] == 0 and none_summary["forecast_coverage_pct"] == 0.0
    empty_rows, empty_summary = aggregate_account("Nobody", "revenue", [], [], {}, None)
    assert empty_rows == [] and empty_summary["forecast_coverage_pct"] is None and empty_summary["sites_total"] == 0


# ── shaping + writing against a fake cursor (no database) ───────────────────
class _FakeCursor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def execute(self, query, params=None):
        self.calls.append((" ".join(query.split()), params))

    def fetchone(self):
        return None

    def fetchall(self):
        return []


def _unwrap(value):
    return getattr(value, "obj", value)


def test_shape_run_maps_periods_to_dates_and_columns():
    rows = []
    rows += _mk_rows("A", "Active Site", 202507, [10_000.0 + 100 * i for i in range(12)])
    rows += _mk_rows("R", "FedEx - City of Industry", 202507, [1.0] * 8)
    rows += _mk_rows("R", "Whole Foods - CHB", 202603, [4_293.0] * 4)
    rows += _mk_rows("N", "New Site", 202604, [4_000.0] * 3)
    for j in range(12):
        rows += _mk_rows(f"P{j}", f"Pad {j}", 202507, [3_000.0 + 50 * ((i + j) % 4) for i in range(12)])
    result = compute_forecasts(rows, CLOSED, {202506: "test suspect"}, LATEST)
    shaped = shape_run(result, {"A": 7, "R": 9}, initiated_by="unit-test")

    meta = shaped["run_meta"]
    assert meta["forecast_run_id"] == result["run_id"]
    assert meta["engine_version"] == ENGINE_VERSION
    assert meta["target_name"] == "site_monthly"
    assert meta["horizon_months"] == HORIZON
    assert meta["latest_closed_month"] == date(2026, 6, 1)
    assert meta["initiated_by"] == "unit-test"
    assert meta["assumptions"]["items"] == result["run_meta"]["assumptions"]
    assert meta["dataset"]["closed_periods"][0] == "2025-07-01"
    assert meta["dataset"]["suspect_periods"] == {"2025-06-01": "test suspect"}
    assert meta["metrics"] == list(METRICS)

    outputs = shaped["outputs"]
    a1 = next(o for o in outputs if o["job_number"] == "A" and o["metric"] == "revenue" and o["horizon_step"] == 1)
    assert a1["job_key"] == 7
    assert a1["basis_month"] == date(2026, 6, 1)
    assert a1["forecast_month"] == date(2026, 7, 1)
    assert a1["input_periods"][0] == "2025-07-01" and len(a1["input_periods"]) == 12
    assert a1["selected_model"] in ("naive", "recent3", "damped_trend", "contract_flat")
    assert isinstance(a1["model_scores"], dict) and "rule" in a1["model_scores"]
    assert a1["interval_source"] == a1["feature_snapshot"]["source"]
    assert a1["lower_bound"] <= a1["point_forecast"] <= a1["upper_bound"]
    assert a1["engine_version"] == ENGINE_VERSION
    a3 = next(o for o in outputs if o["job_number"] == "A" and o["metric"] == "revenue" and o["horizon_step"] == 3)
    assert a3["forecast_month"] == date(2026, 9, 1)

    r1 = next(o for o in outputs if o["job_number"] == "R" and o["metric"] == "revenue" and o["horizon_step"] == 1)
    assert r1["identity_meta"]["break_month"] == "2026-03-01"
    assert r1["job_key"] == 9

    port = next(o for o in outputs if o["job_number"] == PORTFOLIO_JOB and o["metric"] == "gross_profit")
    assert port["job_key"] is None
    assert port["selected_model"] == "sum_of_site_forecasts"

    # metrics stored exactly as the engine names them
    assert {o["metric"] for o in outputs} <= set(METRICS)
    assert {o["metric"] for o in outputs} >= {"revenue", "gross_profit"}

    track = shaped["track"]
    assert track and all(isinstance(t["origin_month"], date) and isinstance(t["forecast_month"], date) for t in track)
    t = track[0]
    assert t["forecast_month"] == period_to_date(_add_months(date_to_period(t["origin_month"]), t["horizon"]))
    assert t["absolute_error"] == round(abs(t["actual_value"] - t["point_forecast"]), 2)

    status = shaped["status"]
    n = next(s for s in status if s["job_number"] == "N" and s["metric"] == "revenue")
    assert n["status"] == "insufficient_history" and n["last_valid_month"] == date(2026, 6, 1)
    unknown = next(o for o in outputs if o["job_number"].startswith("P"))
    assert unknown["job_key"] is None  # not in dim_job -> NULL, never a fabricated key


def test_write_run_is_ordered_and_marks_validated():
    rows = []
    for j in range(8):
        rows += _mk_rows(f"W{j}", f"Write {j}", 202507, [2_000.0 + 25 * ((i + j) % 3) for i in range(12)])
    result = compute_forecasts(rows, CLOSED, {}, LATEST)
    shaped = shape_run(result, {}, initiated_by="unit-test")
    cur = _FakeCursor()
    write_run(cur, shaped)

    first_sql, first_params = cur.calls[0]
    assert first_sql.startswith("INSERT INTO mart.forecast_run_meta")
    assert first_params["status"] == "running"
    assert _unwrap(first_params["assumptions"]) == {"items": result["run_meta"]["assumptions"]}
    assert first_params["latest_closed_month"] == date(2026, 6, 1)

    tables = [sql.split(" ")[2] for sql, _ in cur.calls if sql.startswith("INSERT INTO")]
    assert tables[0] == "mart.forecast_run_meta"
    assert set(tables) >= {"mart.forecast_output", "mart.forecast_track_record", "mart.forecast_accuracy"}
    n_outputs = sum(1 for t in tables if t == "mart.forecast_output")
    assert n_outputs == len(result["forecast_rows"])

    last_sql, last_params = cur.calls[-1]
    assert last_sql.startswith("UPDATE mart.forecast_run_meta SET status = 'validated'")
    assert last_params[1] == result["run_id"]

    out_sql, out_params = next(c for c in cur.calls if c[0].startswith("INSERT INTO mart.forecast_output"))
    assert "%(forecast_month)s" in out_sql and "%(point_forecast)s" in out_sql
    assert isinstance(_unwrap(out_params["input_periods"]), list)
    assert isinstance(out_params["forecast_month"], date)


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted({k: v for k, v in globals().items()
                            if k.startswith("test_") and callable(v)}.items()):
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as e:
            fails += 1
            print(f"FAIL {name}: {e}")
        except Exception as e:  # noqa: BLE001
            fails += 1
            print(f"ERROR {name}: {type(e).__name__}: {e}")
    sys.exit(1 if fails else 0)
