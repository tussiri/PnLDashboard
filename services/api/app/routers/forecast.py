"""Forecast routes (engine v2, server-side). Reads the latest validated run only.

Every response carries ``source`` (mart freshness) and, where a run exists, the run meta so
the browser can label numbers as governed model forecasts anchored on a closed month
(HANDOFF rule 8). Nothing here computes a forecast during a request; POST /forecasts/rebuild
is the only entry point and it is admin-gated.

With ``account=`` the unfiltered ``__ALL__`` portfolio row is omitted and an ``__ACCOUNT__`` row
(the sum of that account's forecast site rows per horizon, built by
``forecasting.aggregate_account``) leads instead, alongside ``account_summary`` so the page can
show how much of the account the forecast actually covers.

``scope=key|all|other`` (default ``key``, docs/reporting-scope.md) is the same key-account scope the
rest of the reporting API uses, expressed as "the scope's sites": with ``key`` or ``other`` and no
account, the rows are the scope's site rows led by a ``__SCOPE__`` aggregate (the same shape and
arithmetic as ``__ACCOUNT__``, ``job_name`` = the scope label) instead of ``__ALL__``, and
``account_summary`` describes that aggregate. ``scope=all`` keeps the portfolio ``__ALL__`` row.
``account`` still wins over ``scope``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ..common import (MartFilters, jsonable, require_admin, resolve_filters, scope_block,
                      source_block)
from ..db import connection
from ..forecasting import (ACCOUNT_JOB, METRICS, PORTFOLIO_JOB, SCOPE_JOB, aggregate_account,
                           build_forecasts, portfolio_history)

router = APIRouter()

_ROW_SQL = """
    SELECT o.job_number, o.job_name, o.metric, o.basis_month, o.forecast_month, o.horizon_step,
           o.point_forecast, o.lower_bound, o.upper_bound, o.selected_model, o.explanation,
           o.n_history, o.status, o.volatility_class, o.input_periods, o.excluded_periods,
           o.model_scores, o.feature_snapshot, o.disruption, o.identity_meta, o.quality_meta,
           o.engine_version,
           a.n_backtests, a.median_ape, a.mase, a.coverage
    FROM mart.forecast_output o
    LEFT JOIN mart.forecast_accuracy a
      ON a.forecast_run_id = o.forecast_run_id AND a.job_number = o.job_number
     AND a.metric = o.metric AND a.horizon_step = o.horizon_step
    WHERE o.forecast_run_id = %s
"""


def _metric(value: str) -> str:
    if value not in METRICS:
        raise HTTPException(status_code=422, detail=f"metric must be one of {', '.join(METRICS)}")
    return value


def _latest_run(cursor: Any) -> dict[str, Any] | None:
    cursor.execute("SELECT * FROM mart.v_forecast_latest_run")
    return cursor.fetchone()


def _run_meta(run: dict[str, Any] | None) -> dict[str, Any] | None:
    if not run:
        return None
    assumptions = run.get("assumptions") or {}
    if isinstance(assumptions, dict):
        assumptions = assumptions.get("items") or []
    return jsonable({
        "run_id": str(run["forecast_run_id"]),
        "engine_version": run["engine_version"],
        "generated_at": run.get("training_completed_at") or run.get("created_at"),
        "latest_closed_month": run["latest_closed_month"],
        "horizon_months": run["horizon_months"],
        "target_name": run.get("target_name"),
        "initiated_by": run.get("initiated_by"),
        "metrics": list(run.get("metrics") or []),
        "dataset": run.get("dataset") or {},
        "gates": run.get("gates") or {},
        "coverage": run.get("coverage") or {},
        "disruption": run.get("disruption") or {},
        "portfolio": run.get("portfolio") or {},
        "assumptions": assumptions,
    })


def _forecast_row(r: dict[str, Any], dims: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    accuracy = None
    if r.get("n_backtests") is not None:
        accuracy = {"n_backtests": r["n_backtests"], "median_ape": r["median_ape"],
                    "mase": r["mase"], "coverage": r["coverage"]}
    quality = r.get("quality_meta") or {}
    dim = (dims or {}).get(r["job_number"], {})
    return jsonable({
        "job_number": r["job_number"],
        "job_name": r["job_name"],
        "metric": r["metric"],
        "basis_month": r["basis_month"],
        "forecast_month": r["forecast_month"],
        "horizon_step": r["horizon_step"],
        "point": r["point_forecast"],
        "lo": r["lower_bound"],
        "hi": r["upper_bound"],
        "method": r["selected_model"],
        "explanation": r["explanation"],
        "n_history": r["n_history"],
        "status": r["status"],
        "volatility_class": r["volatility_class"],
        "input_months": r["input_periods"] or [],
        "excluded_months": r["excluded_periods"] or [],
        "method_selection": r["model_scores"] or {},
        "interval": r["feature_snapshot"] or {},
        "disruption": r["disruption"],
        "identity": r["identity_meta"],
        "quality": r["quality_meta"] or {},
        "engine_version": r["engine_version"],
        "accuracy": accuracy,
        "delivery_model": quality.get("delivery_model") or dim.get("delivery_model"),
        "parent_account": quality.get("parent_account") or dim.get("parent_account"),
    })


LEAD_JOBS = (PORTFOLIO_JOB, ACCOUNT_JOB, SCOPE_JOB)


def _scope_jobs(cursor: Any, filters: MartFilters) -> set[str]:
    """The job numbers in scope (`mart.job_month`), i.e. the sites the aggregate row sums."""
    clause, params = filters.clause("jm")
    cursor.execute(
        f"SELECT DISTINCT jm.job_number FROM mart.job_month jm WHERE jm.job_number IS NOT NULL{clause}",
        params,
    )
    return {r["job_number"] for r in cursor.fetchall()}


def _scope_last_closed(cursor: Any, filters: MartFilters, month: Any) -> dict[str, dict[str, Any]]:
    """The scope's jobs in the last closed month with their actuals (the aggregation's denominator)."""
    if month is None:
        return {}
    clause, params = filters.clause("jm")
    cursor.execute(
        f"""
        SELECT jm.job_number, jm.revenue, jm.labor_cost, jm.subcontract_cost, jm.gross_profit, jm.delivery_model
        FROM mart.job_month jm
        WHERE jm.month = %s AND jm.job_number IS NOT NULL{clause}
        """,
        (month, *params),
    )
    return {r["job_number"]: {
        "revenue": float(r["revenue"] or 0), "labor_cost": float(r["labor_cost"] or 0),
        "subcontract_cost": float(r["subcontract_cost"] or 0), "gross_profit": float(r["gross_profit"] or 0),
        "delivery_model": r["delivery_model"],
    } for r in cursor.fetchall()}


def _job_dims(cursor: Any, job_numbers: set[str] | None = None) -> dict[str, dict[str, Any]]:
    """job_number -> {delivery_model, parent_account} from each job's latest mart.job_month row."""
    if job_numbers is not None and not job_numbers:
        return {}
    cursor.execute(
        """
        SELECT DISTINCT ON (job_number) job_number, delivery_model, parent_account
        FROM mart.job_month
        WHERE job_number IS NOT NULL AND (%s::text[] IS NULL OR job_number = ANY(%s::text[]))
        ORDER BY job_number, month DESC
        """,
        (list(job_numbers) if job_numbers is not None else None,
         list(job_numbers) if job_numbers is not None else None),
    )
    return {r["job_number"]: {"delivery_model": r["delivery_model"], "parent_account": r["parent_account"]}
            for r in cursor.fetchall()}


@router.get("/forecasts")
def list_forecasts(metric: str = Query("revenue"),
                   filters: MartFilters = Depends(resolve_filters)) -> dict[str, Any]:
    """Forecast rows for the requested scope (default: the key accounts).

    `scope=all` with no account is the historical behaviour: the `__ALL__` portfolio row leads.
    An `account` leads with `__ACCOUNT__`; a narrowing scope with no account leads with `__SCOPE__`
    (the same aggregate over the scope's sites). Whatever leads, `account_summary` describes it.
    """
    metric = _metric(metric)
    account = filters.account
    narrowed = filters.clause("jm")[0] != ""
    with connection() as conn, conn.cursor() as cursor:
        run = _latest_run(cursor)
        rows: list[dict[str, Any]] = []
        not_forecast: list[dict[str, Any]] = []
        account_summary: dict[str, Any] | None = None
        if run:
            run_id = run["forecast_run_id"]
            cursor.execute(_ROW_SQL + " AND o.metric = %s", (run_id, metric))
            raw = cursor.fetchall()
            cursor.execute(
                """
                SELECT job_number, job_name, metric, status, reason, last_valid_month, n_valid
                FROM mart.forecast_series_status WHERE forecast_run_id = %s AND metric = %s
                ORDER BY job_number
                """,
                (run_id, metric),
            )
            statuses = cursor.fetchall()
            allowed: set[str] | None = _scope_jobs(cursor, filters) if narrowed else None
            dims = _job_dims(cursor, allowed)
            # Within a scope the unfiltered portfolio row is omitted: a scoped page must never
            # headline the whole portfolio's number as the scope's.
            rows = [_forecast_row(r, dims) for r in raw
                    if (allowed is None and r["job_number"] == PORTFOLIO_JOB)
                    or (allowed is not None and r["job_number"] in allowed)
                    or (allowed is None and r["job_number"] != PORTFOLIO_JOB)]
            not_forecast = [{**jsonable(dict(s)), "delivery_model": dims.get(s["job_number"], {}).get("delivery_model")}
                            for s in statuses if allowed is None or s["job_number"] in allowed]
            if narrowed:
                last_closed = _scope_last_closed(cursor, filters, run.get("latest_closed_month"))
                aggregate_job = ACCOUNT_JOB if account else SCOPE_JOB
                label = account if account else filters.label
                possessive = None if account else f"the {filters.label.lower()}'"
                lead_rows, account_summary = aggregate_account(
                    label, metric, rows, not_forecast, last_closed,
                    jsonable(run.get("latest_closed_month")), run.get("horizon_months") or 3,
                    aggregate_job=aggregate_job, possessive=possessive,
                    subject="the account" if account else "the scope")
                account_summary["scope"] = filters.mode
                account_summary["aggregate_row"] = aggregate_job
                rows = lead_rows + rows
    # Lead rows (__ALL__ / __ACCOUNT__ / __SCOPE__) in horizon order so the first row is always
    # horizon 1; site rows by point desc as before.
    rows.sort(key=lambda r: (
        r["job_number"] not in LEAD_JOBS,
        r["horizon_step"] if r["job_number"] in LEAD_JOBS else 0,
        -(r["point"] or 0), r["job_number"], r["horizon_step"]))
    return {"source": source_block(), "metric": metric, "account": account,
            "scope": scope_block(filters), "filters": filters.active(), "run": _run_meta(run), "rows": rows,
            "not_forecast": not_forecast, "account_summary": account_summary}


@router.get("/forecasts/meta")
def forecast_meta() -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        run = _latest_run(cursor)
    return {"source": source_block(), "run": _run_meta(run)}


@router.get("/forecasts/history")
def forecast_history(metric: str = Query("revenue"), account: str | None = Query(None)) -> dict[str, Any]:
    """The fitted history. `account=` returns that account's own series; without one the portfolio
    series is returned unscoped - the engine's gates are portfolio-level, so a key-account history
    would not line up with the bands the site forecasts were built from."""
    metric = _metric(metric)
    return {"source": source_block(), "metric": metric, "account": account,
            "rows": portfolio_history(metric, account)}


@router.get("/forecasts/track-record")
def forecast_track_record(metric: str = Query("revenue"),
                          job_number: str = Query(PORTFOLIO_JOB)) -> dict[str, Any]:
    metric = _metric(metric)
    with connection() as conn, conn.cursor() as cursor:
        run = _latest_run(cursor)
        rows: list[dict[str, Any]] = []
        if run:
            cursor.execute(
                """
                SELECT origin_month, forecast_month, horizon, method, point_forecast, lower_bound,
                       upper_bound, actual_value, scaled_error, interval_hit, volatility_class
                FROM mart.forecast_track_record
                WHERE forecast_run_id = %s AND metric = %s AND job_number = %s
                ORDER BY forecast_month, horizon
                """,
                (run["forecast_run_id"], metric, job_number),
            )
            rows = [jsonable({
                "origin_month": r["origin_month"], "forecast_month": r["forecast_month"],
                "horizon": r["horizon"], "method": r["method"], "point": r["point_forecast"],
                "lo": r["lower_bound"], "hi": r["upper_bound"], "actual": r["actual_value"],
                "scaled_error": r["scaled_error"], "in_band": r["interval_hit"],
                "volatility_class": r["volatility_class"],
            }) for r in cursor.fetchall()]
    return {"source": source_block(), "metric": metric, "job_number": job_number,
            "run": _run_meta(run), "rows": rows}


@router.post("/forecasts/rebuild", dependencies=[Depends(require_admin)])
def rebuild_forecasts() -> dict[str, Any]:
    return build_forecasts(initiated_by="admin-api")


@router.get("/forecasts/{job_number}")
def job_forecast(job_number: str, months: int = Query(24, ge=1, le=60)) -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        run = _latest_run(cursor)
        cursor.execute(
            """
            SELECT month, job_name, revenue, gross_profit, labor_cost, subcontract_cost, hours,
                   delivery_model, parent_account, data_quality_status
            FROM mart.job_month WHERE job_number = %s ORDER BY month DESC LIMIT %s
            """,
            (job_number, months),
        )
        history = [jsonable(dict(r)) for r in reversed(cursor.fetchall())]
        rows: list[dict[str, Any]] = []
        accuracy: list[dict[str, Any]] = []
        statuses: list[dict[str, Any]] = []
        if run:
            run_id = run["forecast_run_id"]
            dims = _job_dims(cursor, {job_number}) if job_number != PORTFOLIO_JOB else {}
            cursor.execute(_ROW_SQL + " AND o.job_number = %s ORDER BY o.metric, o.horizon_step",
                           (run_id, job_number))
            rows = [_forecast_row(r, dims) for r in cursor.fetchall()]
            cursor.execute(
                """
                SELECT metric, horizon_step, method, n_backtests, median_ape, mape, mase, coverage,
                       volatility_class
                FROM mart.forecast_accuracy WHERE forecast_run_id = %s AND job_number = %s
                ORDER BY metric, horizon_step
                """,
                (run_id, job_number),
            )
            accuracy = [jsonable(dict(r)) for r in cursor.fetchall()]
            cursor.execute(
                """
                SELECT metric, status, reason, last_valid_month, n_valid
                FROM mart.forecast_series_status WHERE forecast_run_id = %s AND job_number = %s
                """,
                (run_id, job_number),
            )
            statuses = [{**jsonable(dict(r)), "delivery_model": dims.get(job_number, {}).get("delivery_model")}
                        for r in cursor.fetchall()]
        job_name = None
        if rows:
            job_name = rows[0]["job_name"]
        elif history:
            job_name = history[-1].get("job_name")
        elif job_number != PORTFOLIO_JOB:
            cursor.execute("SELECT job_name FROM core.dim_job WHERE job_number = %s AND valid_to IS NULL", (job_number,))
            found = cursor.fetchone()
            if not found:
                raise HTTPException(status_code=404, detail=f"Unknown job {job_number}")
            job_name = found["job_name"]
    return {"source": source_block(), "job_number": job_number, "job_name": job_name,
            "run": _run_meta(run), "rows": rows, "accuracy": accuracy,
            "not_forecast": statuses, "history": history}
