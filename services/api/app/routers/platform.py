"""Platform routes: system status, WinTeam integration operations, the finance reference source,
freshness, settings, dimensions.

Admin routes (test, sync, reference load, mart rebuild, settings updates) require the X-Admin-Token
header. WinTeam credentials are never returned; only the base URL host is disclosed, and the same
applies to the reference database (host only).
"""
from __future__ import annotations

import json
from urllib.parse import urlparse
import logging
from datetime import datetime, timezone
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import companycam, marts
from ..common import (PRIMARY_SOURCES, configured_key_accounts, month_status_rows, jsonable,
                      require_admin)
from ..config import settings
from ..db import connection, database_ready
from .. import reconcile
from ..sources import finance_reference
from ..winteam import RESOURCES, WinTeamError, parse_paged, sarus_ingestion, winteam

logger = logging.getLogger("platform")
router = APIRouter()


class SettingUpdate(BaseModel):
    value: Any


# ── helpers ──────────────────────────────────────────────────────────────────
def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _marts_block() -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT (SELECT max(month) FROM mart.portfolio_month) AS latest_month,
                   (SELECT count(*) FROM mart.job_month) AS job_month_rows,
                   (SELECT count(*) FROM mart.portfolio_month) AS portfolio_month_rows,
                   (SELECT max(completed_at) FROM mart.rebuild_log WHERE status = 'succeeded') AS rebuilt_at,
                   (SELECT status FROM mart.rebuild_log ORDER BY started_at DESC LIMIT 1) AS last_rebuild_status
            """
        )
        return jsonable(cursor.fetchone() or {})


def _forecast_block() -> dict[str, Any] | None:
    try:
        with connection() as conn, conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT forecast_run_id AS run_id, engine_version, latest_closed_month,
                       coalesce(training_completed_at, created_at) AS generated_at
                FROM mart.v_forecast_latest_run
                """
            )
            row = cursor.fetchone()
    except psycopg.Error as exc:  # forecast tables not migrated yet
        logger.warning("Forecast status unavailable: %s", exc.__class__.__name__)
        return None
    if not row:
        return None
    return {"run_id": str(row["run_id"]), **jsonable({k: v for k, v in row.items() if k != "run_id"})}


def _latest_run(cursor: Any, integration: str, resource: str | None = None) -> dict[str, Any]:
    cursor.execute(
        """
        SELECT status, completed_at, records_inserted
        FROM ops.integration_sync_run
        WHERE integration_name = %s AND (%s::text IS NULL OR resource_name = %s)
        ORDER BY started_at DESC LIMIT 1
        """,
        (integration, resource, resource),
    )
    return cursor.fetchone() or {}


def _sources_block() -> list[dict[str, Any]]:
    """Every server-side source with its configuration and last run (contract: /system/status.sources)."""
    with connection() as conn, conn.cursor() as cursor:
        api_run = _latest_run(cursor, "winteam")
        ref_run = _latest_run(cursor, finance_reference.INTEGRATION, "load")
        primary = finance_reference.read_primary_source()
    return [
        {
            "name": "winteam_api",
            "configured": settings.winteam_configured,
            "enabled": settings.winteam_enabled,
            "primary": primary == "winteam_api",
            "last_status": api_run.get("status"),
            "last_completed_at": _iso(api_run.get("completed_at")),
            "records": api_run.get("records_inserted"),
        },
        {
            "name": "finance_reference",
            "configured": settings.finance_reference_configured,
            "enabled": settings.finance_reference_configured,
            "primary": primary == "finance_reference",
            "last_status": ref_run.get("status"),
            "last_completed_at": _iso(ref_run.get("completed_at")),
            "records": ref_run.get("records_inserted"),
        },
    ]


# ── status ───────────────────────────────────────────────────────────────────
@router.get("/system/status")
def system_status() -> dict[str, Any]:
    return {
        "database": {"ok": database_ready()},
        "winteam": winteam.status(),
        "sources": _sources_block(),
        "marts": _marts_block(),
        "forecast": _forecast_block(),
    }


@router.get("/integrations/winteam")
def integration_status() -> dict[str, Any]:
    """Connector status; each resource carries `entitled` (false after an HTTP 403, null before any
    sync) and the block carries `normalize_enabled` (WINTEAM_NORMALIZE)."""
    return winteam.status()


@router.get("/integrations/finance-reference")
def finance_reference_status() -> dict[str, Any]:
    return jsonable(finance_reference.status())


@router.post("/integrations/finance-reference/load", dependencies=[Depends(require_admin)])
def finance_reference_load() -> dict[str, Any]:
    """Full replace of the warehouse from the restored Finance_Dashboard database (see docs/finance-reference-source.md)."""
    if not settings.finance_reference_configured:
        raise HTTPException(status_code=409, detail="FINANCE_REFERENCE_DATABASE_URL is not configured")
    try:
        return jsonable(finance_reference.load(initiated_by="admin-api"))
    except psycopg.Error as exc:
        raise HTTPException(status_code=502, detail=f"finance_reference load failed: {exc.__class__.__name__}: {str(exc)[:500]}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/integrations/winteam/test", dependencies=[Depends(require_admin)])
def integration_test() -> dict[str, Any]:
    try:
        return winteam.test_connection()
    except WinTeamError as exc:
        raise HTTPException(status_code=502, detail={"ok": False, "error": str(exc), "field_errors": exc.errors}) from exc


@router.post("/integrations/winteam/sync/{resource}", dependencies=[Depends(require_admin)])
def integration_sync(
    resource: str,
    normalize: bool | None = Query(None, description="false = land raw payloads only; default WINTEAM_NORMALIZE"),
    deep: bool = Query(False, description="true = re-read WINTEAM_DEEP_LOOKBACK_DAYS (35) instead of WINTEAM_LOOKBACK_DAYS (3)"),
) -> dict[str, Any]:
    if resource not in RESOURCES:
        raise HTTPException(status_code=404, detail=f"Unknown resource {resource}; valid names: {', '.join(RESOURCES)}")
    try:
        # Naming one resource is an explicit request for it: the daily skip does not apply.
        result = winteam.sync(resource, normalize=normalize, force=True, deep=deep)
    except WinTeamError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if result.get("status") != "succeeded":
        # A resource the tenant is not entitled to is a tenant fact, not a gateway failure.
        raise HTTPException(status_code=409 if result.get("entitled") is False else 502, detail=result)
    return result


@router.post("/integrations/winteam/watermark/{resource}/reset", dependencies=[Depends(require_admin)])
def integration_reset_watermark(resource: str) -> dict[str, Any]:
    """Forget a resource's incremental watermark so the next sync backfills WINTEAM_BACKFILL_MONTHS.

    Raw records are never deleted: a full re-pull lands only payload versions not already stored,
    so this is safe to run to extend history or to re-read edited records beyond the lookback.
    """
    if resource not in RESOURCES:
        raise HTTPException(status_code=404, detail=f"Unknown resource {resource}; valid names: {', '.join(RESOURCES)}")
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            "DELETE FROM ops.source_watermark WHERE integration_name = 'winteam' AND resource_name = %s",
            (resource,),
        )
        removed = cursor.rowcount
        conn.commit()
    return {"resource": resource, "watermark_removed": removed > 0, "next_sync": "full backfill"}


@router.post("/integrations/winteam/sync", dependencies=[Depends(require_admin)])
def integration_sync_all(
    normalize: bool | None = Query(None, description="false = raw landing only, no normalization or mart rebuild; default WINTEAM_NORMALIZE"),
    resources: str | None = Query(None, description="Comma separated subset of the enabled resources"),
    force: bool = Query(False, description="true = also re-read jobs, vendors, budgets and AR synced within the last 20 hours"),
    deep: bool = Query(False, description="true = re-read WINTEAM_DEEP_LOOKBACK_DAYS (35) of timekeeping and AP instead of WINTEAM_LOOKBACK_DAYS (3)"),
) -> dict[str, Any]:
    selected = [name.strip() for name in resources.split(",") if name.strip()] if resources else None
    try:
        return jsonable(winteam.sync_all(normalize=normalize, resources=selected, force=force, deep=deep))
    except WinTeamError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/marts/rebuild", dependencies=[Depends(require_admin)])
def marts_rebuild() -> dict[str, Any]:
    try:
        return jsonable(marts.rebuild_all(initiated_by="admin-api"))
    except marts.MartRebuildBlocked as exc:
        # 409, not a hung request: the rebuild gave up on its lock instead of queueing behind
        # whoever holds it and taking every reader of mart.* down with it.
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/integrations/winteam/runs")
def integration_runs(limit: int = Query(25, ge=1, le=200)) -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, resource_name, status, started_at, completed_at, records_fetched, records_inserted, error_message
            FROM ops.integration_sync_run
            WHERE integration_name = 'winteam'
            ORDER BY started_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        runs = [{**jsonable(row), "id": str(row["id"])} for row in cursor.fetchall()]
    return {"runs": runs}


# WinTeam is synced on demand only (worker.py never calls it), so no resource is behind a schedule:
# freshness reports each resource's age since its last completed sync and never calls it overdue.
# finance_reference is the PRIMARY source of the job-cost P&L (revenue, direct labor, subcontract
# cost by site and month) and is loaded by hand from a restored dump - nothing polls it. Left
# unreloaded it does not go blank, it goes SHORT: timekeeping keeps arriving from the live API
# while revenue stops at the last exported month, so the newest months show labor against little or
# no revenue and read as a collapse in margin. The export follows the monthly close, so a load older
# than this is behind by at least one closed month and the P&L months it feeds cannot be trusted.
REFERENCE_STALE_AFTER_SECONDS = 7 * 86400


def _mark_overdue(resource: dict[str, Any]) -> dict[str, Any]:
    """Add `overdue` (always None: nothing is scheduled), `overdue_after_seconds` (None) and
    `not_entitled` (the tenant answered HTTP 403) to one freshness row."""
    resource["overdue_after_seconds"] = None
    resource["not_entitled"] = (resource.get("last_status") == "failed"
                                and "not_entitled" in (resource.get("last_error") or ""))
    resource["overdue"] = None
    return resource


def _sarus_identity() -> dict[str, Any]:
    return {
        "configured": settings.winteam_sarus_configured,
        "enabled": settings.winteam_sarus_enabled,
        "base_url_host": urlparse(settings.winteam_sarus_base_url).hostname if settings.winteam_sarus_base_url else None,
        "has_subscription_key": bool(settings.winteam_sarus_subscription_key),
        "ingestion": settings.winteam_sarus_enabled and settings.winteam_sarus_configured,
        "sync": "on_demand",
    }


@router.get("/integrations/winteam/sarus")
def winteam_sarus_status() -> dict[str, Any]:
    """The second WinTeam database: identity, per-resource runs and the precedence windows. Never
    returns the tenant id or key."""
    status = sarus_ingestion().status()
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT sarus_timekeeping_from, sarus_timekeeping_to, sarus_ap_invoice_from, sarus_ap_invoice_to,
                   sarus_ar_invoices_api
            FROM mart.v_source_precedence
            """
        )
        window = cursor.fetchone() or {}
    return jsonable({
        **_sarus_identity(),
        "resources": [r for r in status["resources"] if r["enabled"]],
        "precedence": dict(window),
    })


@router.post("/integrations/winteam/sarus/sync", dependencies=[Depends(require_admin)])
def winteam_sarus_sync(
    normalize: bool | None = Query(None, description="false = raw landing only, no normalization or mart rebuild; default WINTEAM_NORMALIZE"),
    resources: str | None = Query(None, description="Comma separated subset of the Sarus resources"),
    force: bool = Query(False, description="true = also re-read jobs, vendors, budgets and AR synced within the last 20 hours"),
    deep: bool = Query(False, description="true = re-read WINTEAM_DEEP_LOOKBACK_DAYS (35) of timekeeping and AP instead of WINTEAM_LOOKBACK_DAYS (3)"),
) -> dict[str, Any]:
    """Sync the Sarus database now (GET-only, as the primary). Requires WINTEAM_SARUS_ENABLED; nothing
    syncs it on a schedule."""
    selected = [name.strip() for name in resources.split(",") if name.strip()] if resources else None
    try:
        return jsonable(sarus_ingestion().sync_all(normalize=normalize, resources=selected, force=force, deep=deep))
    except WinTeamError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/integrations/winteam/sarus/test", dependencies=[Depends(require_admin)])
def winteam_sarus_test() -> dict[str, Any]:
    """Read-only credential check against the Sarus database: one GET of the jobs list.

    Works before WINTEAM_SARUS_ENABLED is set, so credentials can be checked first. Reports which
    company numbers the tenant returns, so it is plain whether the id points at Sarus or back at
    a Crane company. Lands nothing.
    """
    if not settings.winteam_sarus_configured:
        return {**_sarus_identity(), "ok": False,
                "error": "Set WINTEAM_SARUS_TENANT_ID (and WINTEAM_SARUS_SUBSCRIPTION_KEY) in the server .env"}
    connector = sarus_ingestion(enabled=True)
    try:
        with connector._client() as client:
            page = parse_paged(client.get("/jobs/v2/api/jobs", {"pageSize": 100, "pageNumber": 1}))
    except WinTeamError as exc:
        return {**_sarus_identity(), "ok": False, "status_code": exc.status_code, "error": str(exc)[:300]}
    companies = sorted({str(r.get("companyNumber")) for r in page.results if r.get("companyNumber") is not None})
    # Company numbers are numbered per WinTeam database - Sarus and Crane both have a company 1 - so
    # they cannot tell the two apart. Job identity can: a Sarus tenant returns the jobs the export
    # already knows as Sarus (300 "Amazon - BDL3/7"), and a Crane tenant returns Crane jobs.
    known = known_jobs_by_company()
    api_jobs = {(str(r.get("jobNumber")), str(r.get("jobDescription") or "").strip()) for r in page.results}
    return {
        **_sarus_identity(),
        "ok": True,
        "jobs_total": page.total_count,
        "company_numbers": companies,
        "matches_known_sarus_jobs": len(api_jobs & known.get("Sarus", set())),
        "matches_known_crane_jobs": len(api_jobs & known.get("Crane", set())),
        "sample_jobs": [
            {"jobNumber": r.get("jobNumber"), "jobDescription": r.get("jobDescription"), "companyNumber": r.get("companyNumber")}
            for r in page.results[:8]
        ],
    }


def known_jobs_by_company() -> dict[str, set[tuple[str, str]]]:
    """(job number, job name) already in the warehouse, grouped Sarus vs Crane."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT CASE WHEN company = 'Sarus' THEN 'Sarus' ELSE 'Crane' END AS ns,
                   regexp_replace(job_number, '^[A-Za-z]+:', '') AS job_number, btrim(job_name) AS job_name
            FROM core.dim_job WHERE valid_to IS NULL AND job_name IS NOT NULL
            """
        )
        out: dict[str, set[tuple[str, str]]] = {}
        for row in cursor.fetchall():
            out.setdefault(row["ns"], set()).add((str(row["job_number"]), str(row["job_name"])))
    return out


@router.get("/integrations/companycam")
def companycam_status() -> dict[str, Any]:
    """Whether site photos are available. Never returns the token."""
    return companycam.status()


@router.get("/integrations/companycam/probe", dependencies=[Depends(require_admin)])
def companycam_probe(limit: int = Query(5, ge=1, le=25)) -> dict[str, Any]:
    """Read-only look at real CompanyCam projects, to choose a match rule from evidence.

    Admin-only and deliberately small: it reports which fields the projects carry and a handful of
    redacted samples, not a customer's photo library. Run it once with the production token to see
    whether projects hold the job number in their name, a usable address, or neither.
    """
    if not companycam.configured():
        return companycam.status()
    try:
        return companycam.probe(limit=limit)
    except companycam.CompanyCamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/data/reconciliation")
def data_reconciliation(months: int = Query(6, ge=1, le=24)) -> dict[str, Any]:
    """Prove the published figures trace to WinTeam payloads (app.reconcile).

    `raw -> core` must agree to the cent. `suppressed_ar` is invoiced AR the mart publishes as zero
    revenue - never correct, and the defect that hid $9.7M across July and August 2026.
    """
    return reconcile.ar_chain(months=months)


@router.get("/data/freshness")
def data_freshness() -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT resource_name, last_status, last_completed_at, records_fetched, records_inserted,
                   last_error, watermark_value, seconds_since_last_completion
            FROM mart.v_winteam_ingestion_freshness
            """
        )
        by_name = {row["resource_name"]: jsonable(row) for row in cursor.fetchall()}
    resources = []
    for name in RESOURCES:
        if name in by_name:
            resources.append(by_name.pop(name))
        elif name in settings.winteam_resources:
            resources.append(
                {
                    "resource_name": name,
                    "last_status": None,
                    "last_completed_at": None,
                    "records_fetched": None,
                    "records_inserted": None,
                    "last_error": None,
                    "watermark_value": None,
                    "seconds_since_last_completion": None,
                }
            )
    reference_names = {"load", "reset", "settings", "stage", "dim_job", "fact_job_cost_month", "fact_labor_budget_month",
                       "fact_timekeeping", "fact_ar_invoice", "fact_ap_invoice"}
    resources.extend(v for k, v in by_name.items() if k not in reference_names)  # historical resource names no longer in the catalogue
    resources = [_mark_overdue(r) for r in resources]
    reference = finance_reference.last_load()
    reference_age = (
        int((datetime.now(timezone.utc) - datetime.fromisoformat(reference["completed_at"])).total_seconds())
        if reference and reference.get("completed_at") else None
    )
    reference_stale = bool(
        settings.finance_reference_configured
        and (reference_age is None or reference_age > REFERENCE_STALE_AFTER_SECONDS)
    )
    return {
        "resources": resources,
        "ingestion": {
            "healthy": not reference_stale,
            "overdue_resources": [],
            "overdue_after_seconds": None,
            "poll_seconds": None,
            "sync": "on_demand",
            "reference_stale": reference_stale,
            "reference_stale_after_seconds": REFERENCE_STALE_AFTER_SECONDS,
        },
        "finance_reference": {
            "configured": settings.finance_reference_configured,
            "last_load": reference,
            "seconds_since_last_completion": reference_age,
            "stale": reference_stale,
        },
        "marts": _marts_block(),
    }


# ── settings ─────────────────────────────────────────────────────────────────
def _fraction(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise ValueError("must be a number between 0 and 1")
    return float(value)


def _non_negative(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValueError("must be a non-negative number")
    return float(value)


def _int_range(low: int, high: int):
    def check(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError(f"must be an integer between {low} and {high}")
        return value

    return check


def _int_list(value: Any) -> list[int]:
    if not isinstance(value, list) or any(isinstance(v, bool) or not isinstance(v, int) for v in value):
        raise ValueError("must be a list of integers")
    return value


def _gl_classes(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("must be an object keyed by account class")
    allowed = {"revenue", "direct_labor", "subcontract", "supplies"}
    for key, spec in value.items():
        if key not in allowed or not isinstance(spec, dict):
            raise ValueError(f"class {key!r} must be one of {sorted(allowed)} with a {{ranges, keywords}} object")
        ranges = spec.get("ranges", [])
        keywords = spec.get("keywords", [])
        if not isinstance(ranges, list) or any(
            not isinstance(r, list) or len(r) != 2 or any(isinstance(b, bool) or not isinstance(b, int) for b in r) for r in ranges
        ):
            raise ValueError(f"{key}.ranges must be a list of [low, high] integer pairs")
        if not isinstance(keywords, list) or any(not isinstance(k, str) for k in keywords):
            raise ValueError(f"{key}.keywords must be a list of strings")
    return value


def _tier_map(value: Any) -> dict[str, Any]:
    allowed = {"region", "branch", "service_type", "manager", "vertical"}
    if not isinstance(value, dict) or any(k not in allowed for k in value):
        raise ValueError(f"must be an object with keys from {sorted(allowed)}")
    for key, tier in value.items():
        if tier is not None and (isinstance(tier, bool) or not isinstance(tier, int) or tier < 0):
            raise ValueError(f"{key} must be a tier id (non-negative integer) or null")
    return value


def _string_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
        raise ValueError("must be an object of string values")
    return value


def _rule_list(required: str):
    def check(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list) or any(not isinstance(v, dict) or not isinstance(v.get(required), str) or not v[required].strip() for v in value):
            raise ValueError(f"must be a list of objects each carrying a non-empty string {required!r}")
        return value

    return check


def _primary_source(value: Any) -> str:
    if value not in PRIMARY_SOURCES:
        raise ValueError(f"must be one of {', '.join(PRIMARY_SOURCES)}")
    return value


SETTING_VALIDATORS = {
    "account_groups": _rule_list("name"),
    "ar_treatment_rules": _rule_list("match"),
    "company_aliases": _string_map,
    "primary_source": _primary_source,
    "payroll_burden_rate": _fraction,
    "overtime_weekly_threshold_hours": _non_negative,
    "overtime_category_detail_ids": _int_list,
    "fiscal_year_start_month": _int_range(1, 12),
    "gl_account_classes": _gl_classes,
    "job_tier_map": _tier_map,
    "customer_names": _string_map,
    "close_lag_days": _int_range(0, 60),
    "margin_target_pct": _fraction,
    "labor_target_pct": _fraction,
}

JSON_TYPES = {dict: "object", list: "array", str: "string", bool: "boolean", int: "number", float: "number", type(None): "null"}


@router.get("/settings")
def list_settings() -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT key, value, description, updated_at, updated_by FROM ops.app_setting ORDER BY key")
        return {"settings": [jsonable(row) for row in cursor.fetchall()]}


@router.put("/settings/{key}", dependencies=[Depends(require_admin)])
def update_setting(key: str, body: SettingUpdate) -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (key,))
        existing = cursor.fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail=f"Unknown setting {key}")
        validator = SETTING_VALIDATORS.get(key)
        try:
            if validator is not None:
                value = validator(body.value)
            else:
                expected = JSON_TYPES.get(type(existing["value"]))
                actual = JSON_TYPES.get(type(body.value))
                if expected != actual:
                    raise ValueError(f"must be a JSON {expected}")
                value = body.value
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Setting {key} {exc}") from exc
        cursor.execute(
            """
            UPDATE ops.app_setting SET value = %s::jsonb, updated_at = now(), updated_by = 'admin-api'
            WHERE key = %s
            RETURNING key, value, description, updated_at, updated_by
            """,
            (json.dumps(value), key),
        )
        row = cursor.fetchone()
        conn.commit()
    return jsonable(row)


# ── dimensions ───────────────────────────────────────────────────────────────
KEY_ACCOUNT_SITES_SQL = """
SELECT parent_account, coalesce(sub_account, parent_account) AS sub_account,
       count(DISTINCT job_number) AS sites
FROM mart.job_month
WHERE parent_account = ANY(%s::text[])
GROUP BY 1, 2
"""

OTHER_ACCOUNT_SITES_SQL = """
SELECT parent_account, count(DISTINCT job_number) AS sites,
       coalesce(sum(revenue) FILTER (WHERE month = %s), 0) AS latest_revenue
FROM mart.job_month
WHERE coalesce(parent_account, '') <> ALL(%s::text[]) AND parent_account IS NOT NULL
GROUP BY 1
ORDER BY latest_revenue DESC, parent_account
"""


@router.get("/dimensions")
def dimensions() -> dict[str, Any]:
    """Filter vocabularies for the shell, including the reporting scope (docs/reporting-scope.md):
    `key_accounts` (the `key_accounts` setting, in configured order, with site and sub-account
    counts), `other_accounts` (every other account, by the latest closed month's revenue desc) and
    `delivery_models`. `accounts` still lists every name for backward compatibility."""
    statuses = month_status_rows()
    months = [row["month"].isoformat() for row in statuses]
    closed_months = [row["month"].isoformat() for row in statuses if row["status"] == "closed"]
    keys = configured_key_accounts()
    key_names = [a["name"] for a in keys]
    latest_closed = closed_months[-1] if closed_months else None
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              array_remove(array_agg(DISTINCT parent_account ORDER BY parent_account), NULL) AS accounts,
              array_remove(array_agg(DISTINCT region ORDER BY region), NULL) AS regions,
              array_remove(array_agg(DISTINCT branch ORDER BY branch), NULL) AS branches,
              array_remove(array_agg(DISTINCT service_type ORDER BY service_type), NULL) AS service_types,
              array_remove(array_agg(DISTINCT vertical ORDER BY vertical), NULL) AS verticals,
              array_remove(array_agg(DISTINCT company ORDER BY company), NULL) AS companies,
              array_remove(array_agg(DISTINCT delivery_model ORDER BY delivery_model), NULL) AS delivery_models
            FROM mart.job_month
            """
        )
        dims = cursor.fetchone() or {}
        cursor.execute(
            """
            SELECT customer_number, coalesce(customer_name, 'Customer ' || customer_number) AS customer_name
            FROM core.dim_customer ORDER BY customer_number
            """
        )
        customers = [dict(row) for row in cursor.fetchall()]
        cursor.execute(KEY_ACCOUNT_SITES_SQL, (key_names,))
        key_rows = cursor.fetchall()
        cursor.execute(OTHER_ACCOUNT_SITES_SQL, (latest_closed, key_names))
        other_accounts = [{"name": r["parent_account"], "sites": int(r["sites"] or 0),
                           "latest_month_revenue": float(r["latest_revenue"] or 0)}
                          for r in cursor.fetchall()]
    subs: dict[str, list[dict[str, Any]]] = {}
    for r in key_rows:
        subs.setdefault(r["parent_account"], []).append({"name": r["sub_account"], "sites": int(r["sites"] or 0)})
    key_accounts = []
    for account in keys:
        rows = sorted(subs.get(account["name"], []), key=lambda x: (-x["sites"], x["name"]))
        key_accounts.append({
            "name": account["name"], "label": account["label"],
            "sites": sum(x["sites"] for x in rows), "sub_accounts": rows,
        })
    return {
        "months": months,
        "month_status": [{"month": r["month"].isoformat(), "status": r["status"]} for r in statuses],
        "latest_month": months[-1] if months else None,
        "latest_closed_month": closed_months[-1] if closed_months else None,
        "default_month": (closed_months[-1] if closed_months else (months[-1] if months else None)),
        "accounts": dims.get("accounts") or [],
        "regions": dims.get("regions") or [],
        "branches": dims.get("branches") or [],
        "service_types": dims.get("service_types") or [],
        "verticals": dims.get("verticals") or [],
        "companies": dims.get("companies") or [],
        "delivery_models": dims.get("delivery_models") or [],
        "customers": customers,
        "key_accounts": key_accounts,
        "other_accounts": other_accounts,
        "scopes": ["key", "all", "other"],
    }
