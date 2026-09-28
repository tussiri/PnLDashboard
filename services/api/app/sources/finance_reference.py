"""Load the real WinTeam report exports (restored Finance_Dashboard dump) into the warehouse.

Source: the read-only `finance_reference` database (FINANCE_REFERENCE_DATABASE_URL). The loader
copies the relevant reference tables into TEMP tables on the application connection, derives the
core facts and dimensions from them (SQL for the bulk copies, the pure rules in `rules.py` for the
judgement calls), and finally rebuilds the marts. Every load is a full replace OF THIS SOURCE: the previous
reference rows are removed first so two export loads can never mix, while everything the live
WinTeam API landed (source 'winteam_api') stays in place (docs/finance-reference-source.md).

Steps (each one is its own transaction and its own ops.integration_sync_run row with
integration_name = 'finance_reference'; the whole load also gets a parent row, resource 'load'):

  reset            delete the previous reference load (rows with source = 'finance_reference'
                   and reference-only dimension rows) and empty the derived marts; the live API's
                   raw landings, watermarks and core rows are never touched
  settings         account_groups / ar_treatment_rules from app.platform_config, the tenant's real
                   job_tier_map, company aliases untouched
  stage            reference tables -> TEMP tables (COPY), plus the Crane job master CSV and the
                   city centroid file from the package data directory
  dim_job          reference dim_job + job file + job master CSV; account groups, delivery model,
                   tiers, addresses, approximate coordinates, customers
  fact_job_cost_month      mart.job_profitability_monthly (the finance-approved job-cost P&L)
  fact_labor_budget_month  daily budget -> hours budget comparison -> wage-by-job budget
  fact_timekeeping         timekeeping detail lines; labor_cost = hours x trailing job rate
  fact_ar_*        AR invoice register (one row per invoice) + every AR aging snapshot
  fact_ap_*        AP vendor aging snapshots, cash requirements, vendor activity (payments)
  marts            marts.rebuild_all(), then ops.app_setting.primary_source = 'finance_reference'

Derivations and their basis labels are documented in docs/finance-reference-source.md.
"""
from __future__ import annotations

import csv
import json
import logging
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import psycopg
from psycopg.types.json import Jsonb

from .. import marts
from ..common import jsonable, month_end
from ..config import settings
from ..db import connection, reference_connection
from . import rules

logger = logging.getLogger("finance_reference")

INTEGRATION = "finance_reference"
SOURCE = "finance_reference"
JOB_MASTER_FILE = "Crane_job_master_report.csv"
CENTROID_FILE = "city_centroids.json"
REAL_JOB_TIER_MAP = {"branch": 1, "region": 3, "service_type": 4, "manager": 7, "vertical": 6}
DEFAULT_CLOSE_LAG_DAYS = 5

# reset_warehouse scope. Fact tables: only rows WHERE source = 'finance_reference' are deleted (the
# live API's rows stay). Dimensions: reference-only rows are deleted; a row the API has since taken
# over (source = 'winteam_api': the GUID, exact coordinates, tiers) is kept and the loader upserts
# the reference-only attributes onto it. Mart tables are derived and are emptied because
# marts.rebuild_all refills them at the end of the load. Never touched: raw.winteam_record,
# ops.source_watermark, ops.app_setting, ops.integration_sync_run, mart.rebuild_log.
RESET_FACT_TABLES = (
    "core.fact_timekeeping",
    "core.fact_schedule",
    "core.fact_gl_budget",          # fact_gl_budget_month rows cascade
    "core.fact_ar_invoice",
    "core.fact_ap_invoice",
    "core.fact_ap_payment",
    "core.fact_job_cost_month",
    "core.fact_labor_budget_month",
    "core.fact_daily_budget",
    "core.contract_billing",
    "core.fact_ar_aging_snapshot",
    "core.fact_ap_aging_snapshot",
)
RESET_DIM_TABLES = ("core.dim_customer", "core.dim_vendor", "core.dim_job")  # core.job_tier cascades from dim_job
RESET_MART_TABLES = ("mart.job_month", "mart.portfolio_month", "mart.job_week", "mart.forecast_run_meta")
RESET_TABLES = RESET_FACT_TABLES + RESET_DIM_TABLES + RESET_MART_TABLES
NEVER_RESET_TABLES = ("raw.winteam_record", "ops.source_watermark", "ops.app_setting", "ops.integration_sync_run", "mart.rebuild_log")
# API fact rows may point (job_key / customer_key / vendor_key) at a reference-only dimension row;
# those pointers are cleared before the dimension row goes and re-pointed by the next API jobs /
# vendors normalization (normalize.repoint_facts / vendors) - the marts join on the natural keys.
_FK_TO_DIM = (
    ("core.fact_timekeeping", "job_key", "core.dim_job", "job_key"),
    ("core.fact_schedule", "job_key", "core.dim_job", "job_key"),
    ("core.fact_ar_invoice", "job_key", "core.dim_job", "job_key"),
    ("core.fact_gl_budget", "job_key", "core.dim_job", "job_key"),
    ("core.fact_job_budget", "job_key", "core.dim_job", "job_key"),
    ("core.fact_ap_distribution", "job_key", "core.dim_job", "job_key"),
    ("core.fact_ar_invoice", "customer_key", "core.dim_customer", "customer_key"),
    ("core.fact_ap_invoice", "vendor_key", "core.dim_vendor", "vendor_key"),
    ("core.fact_ap_payment", "vendor_key", "core.dim_vendor", "vendor_key"),
)

# Reference tables staged into TEMP tables: name -> (column DDL, reference query). Rows from
# superseded import batches are excluded; rows without a batch are kept.
_BATCH_JOIN = "LEFT JOIN raw.import_batches b ON b.id = f.import_batch_id WHERE coalesce(b.status, '') <> 'superseded'"
STAGED: dict[str, tuple[str, str]] = {
    "fr_job": (
        "job_number text, name text, is_self_perform boolean, attributes jsonb",
        "SELECT job_number, name, is_self_perform, attributes_json FROM core.dim_job",
    ),
    "fr_job_file": (
        "id uuid, batch_company text, p jsonb",
        f"SELECT f.id, b.company_name, f.normalized_row_json FROM core.fact_job_file_line f {_BATCH_JOIN}",
    ),
    "fr_job_cost": (
        "period_id integer, job_number text, job_name text, revenue numeric, direct_labor numeric, payroll_taxes_insurance numeric, "
        "materials numeric, subcontractors numeric, equipment_supplies numeric, other_direct_costs numeric, total_direct_costs numeric, "
        "gross_profit numeric, gross_margin_pct numeric, actual_hours numeric, overtime_hours numeric, budget_revenue numeric, "
        "budget_direct_costs numeric, budget_gross_profit numeric, budget_hours numeric, confidence_score integer, "
        "data_quality_status text, exception_count integer, lineage jsonb",
        "SELECT period_id, job_number, job_name, revenue, direct_labor, payroll_taxes_insurance, materials, subcontractors, "
        "equipment_supplies, other_direct_costs, total_direct_costs, gross_profit, gross_margin_pct, actual_hours, overtime_hours, "
        "budget_revenue, budget_direct_costs, budget_gross_profit, budget_hours, confidence_score, data_quality_status, "
        "exception_count, import_lineage_json FROM mart.job_profitability_monthly",
    ),
    "fr_timekeeping": (
        "id uuid, batch_company text, period_id integer, work_date date, p jsonb",
        f"SELECT f.id, b.company_name, f.period_id, f.work_date, f.normalized_row_json FROM core.fact_timekeeping_detail_line f {_BATCH_JOIN} AND f.work_date IS NOT NULL",
    ),
    "fr_wage": (
        "id uuid, batch_company text, period_id integer, p jsonb",
        f"SELECT f.id, b.company_name, f.period_id, f.normalized_row_json FROM core.fact_wage_by_job_line f {_BATCH_JOIN} AND f.period_id IS NOT NULL",
    ),
    "fr_daily_budget": (
        "job_number text, budget_date date, budgeted_dollars numeric, budgeted_hours numeric, company_name text, period_id integer, created_at timestamptz",
        f"SELECT f.job_number, f.budget_date, f.budgeted_dollars, f.budgeted_hours, f.company_name, f.period_id, f.created_at FROM core.fact_daily_budget f {_BATCH_JOIN} AND f.budget_date IS NOT NULL",
    ),
    "fr_hbc": (
        "id uuid, batch_company text, period_id integer, p jsonb",
        f"SELECT f.id, b.company_name, f.period_id, f.normalized_row_json FROM core.fact_hours_budget_comparison_line f {_BATCH_JOIN} AND f.period_id IS NOT NULL",
    ),
    "fr_ar_register": (
        "id uuid, batch_company text, period_id integer, p jsonb",
        f"SELECT f.id, b.company_name, f.period_id, f.normalized_row_json FROM core.fact_ar_invoice_register_line f {_BATCH_JOIN}",
    ),
    "fr_ar_aging": (
        "id uuid, batch_company text, snapshot_date date, p jsonb",
        f"SELECT f.id, b.company_name, f.snapshot_date, f.normalized_row_json FROM core.fact_ar_aging_snapshot_line f {_BATCH_JOIN} AND f.snapshot_date IS NOT NULL",
    ),
    "fr_ap_aging": (
        "id uuid, batch_company text, snapshot_date date, p jsonb",
        f"SELECT f.id, b.company_name, f.snapshot_date, f.normalized_row_json FROM core.fact_ap_vendor_aging_snapshot_line f {_BATCH_JOIN} AND f.snapshot_date IS NOT NULL",
    ),
    "fr_ap_cash": (
        "id uuid, batch_company text, snapshot_date date, p jsonb",
        f"SELECT f.id, b.company_name, f.snapshot_date, f.normalized_row_json FROM core.fact_ap_cash_requirement_line f {_BATCH_JOIN} AND f.snapshot_date IS NOT NULL",
    ),
    "fr_ap_activity": (
        "id uuid, batch_company text, period_id integer, p jsonb",
        f"SELECT f.id, b.company_name, f.period_id, f.normalized_row_json FROM core.fact_ap_vendor_activity_line f {_BATCH_JOIN}",
    ),
    "fr_overrides": (
        "job_number text, assigned_account_group text, assigned_client_name text, is_self_perform_override boolean, labor_basis text",
        "SELECT job_number, assigned_account_group, assigned_client_name, is_self_perform_override, labor_basis FROM app.job_account_overrides",
    ),
}

# SQL expression helpers (field names are code constants, never user input).
NUMBER_RE = r"^\s*-?\d+(\.\d+)?\s*$"
US_DATE_RE = r"^\d{1,2}/\d{1,2}/\d{4}"
HHMM_RE = r"^\d{1,2}:\d{2}$"


def _txt(field: str, src: str = "p") -> str:
    return f"nullif(btrim({src}->>'{field}'), '')"


def _num(field: str, src: str = "p") -> str:
    return f"(CASE WHEN {src}->>'{field}' ~ '{NUMBER_RE}' THEN ({src}->>'{field}')::numeric END)"


def _int(field: str, src: str = "p") -> str:
    return f"(CASE WHEN {src}->>'{field}' ~ '{NUMBER_RE}' THEN round(({src}->>'{field}')::numeric)::integer END)"


def _usdate(field: str, src: str = "p") -> str:
    return f"(CASE WHEN {src}->>'{field}' ~ '{US_DATE_RE}' THEN to_date(substring({src}->>'{field}' from '{US_DATE_RE}'), 'FMMM/FMDD/YYYY') END)"


def _flag(field: str, src: str = "p") -> str:
    return f"(CASE WHEN lower({src}->>'{field}') IN ('true', '1', 'yes') THEN true WHEN lower({src}->>'{field}') IN ('false', '0', 'no') THEN false END)"


def _ns(*exprs: str) -> str:
    """Namespace ('Sarus' | 'Crane') from the first non-null of the given company expressions."""
    return f"(CASE WHEN strpos(lower(coalesce({', '.join(exprs)}, '')), 'sarus') > 0 THEN 'Sarus' ELSE 'Crane' END)"


def _alias(expr: str) -> str:
    """Dashboard company label for a raw company expression, via the %(aliases)s jsonb parameter."""
    return f"coalesce(%(aliases)s::jsonb ->> lower(btrim({expr})), nullif(btrim({expr}), ''))"


# ── run bookkeeping ──────────────────────────────────────────────────────────
def _start_run(conn: Any, resource: str) -> str:
    with conn.cursor() as cursor:
        cursor.execute(
            "INSERT INTO ops.integration_sync_run (integration_name, resource_name, status) VALUES (%s, %s, 'running') RETURNING id",
            (INTEGRATION, resource),
        )
        run_id = str(cursor.fetchone()["id"])
    conn.commit()
    return run_id


def _finish_run(run_id: str, status: str, fetched: int = 0, inserted: int = 0, error: str | None = None) -> None:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ops.integration_sync_run
            SET status = %s, completed_at = now(), records_fetched = %s, records_inserted = %s, error_message = %s
            WHERE id = %s
            """,
            (status, max(int(fetched), 0), max(int(inserted), 0), error, run_id),
        )
        conn.commit()


class _Step:
    """Context manager: one sync-run row and one transaction per load step."""

    def __init__(self, conn: Any, resource: str, tables: list[dict[str, Any]]):
        self.conn = conn
        self.resource = resource
        self.tables = tables
        self.fetched = 0
        self.inserted = 0
        self.run_id = ""

    def __enter__(self) -> "_Step":
        self.run_id = _start_run(self.conn, self.resource)
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc is None:
            self.conn.commit()
            _finish_run(self.run_id, "succeeded", self.fetched, self.inserted)
            self.tables.append({"name": self.resource, "rows": self.inserted})
            logger.info("finance_reference %s: fetched=%s inserted=%s", self.resource, self.fetched, self.inserted)
        else:
            self.conn.rollback()
            _finish_run(self.run_id, "failed", self.fetched, self.inserted, str(exc)[:1000])
            logger.exception("finance_reference %s failed", self.resource)


# ── settings helpers ─────────────────────────────────────────────────────────
def _setting(conn: Any, key: str, default: Any) -> Any:
    with conn.cursor() as cursor:
        cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (key,))
        row = cursor.fetchone()
    return row["value"] if row and row["value"] is not None else default


def _upsert_setting(conn: Any, key: str, value: Any, description: str) -> None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ops.app_setting (key, value, description, updated_by)
            VALUES (%s, %s::jsonb, %s, 'finance_reference')
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = 'finance_reference'
            """,
            (key, json.dumps(value), description),
        )


def _close_lag_days(conn: Any) -> int:
    try:
        return max(0, int(_setting(conn, "close_lag_days", DEFAULT_CLOSE_LAG_DAYS)))
    except (TypeError, ValueError):
        return DEFAULT_CLOSE_LAG_DAYS


def _is_closed(month: date, lag_days: int, today: date) -> bool:
    return (month_end(month) + timedelta(days=lag_days)) < today


# ── data files (job master CSV, city centroids) ──────────────────────────────
def data_dir() -> Path:
    if settings.finance_reference_data_dir:
        return Path(settings.finance_reference_data_dir)
    return Path(__file__).resolve().parent / "data"


def _clean(value: Any) -> str | None:
    text = (value or "").strip() if isinstance(value, str) else value
    if text in (None, "", "None", "none", "NULL"):
        return None
    return str(text)


def read_job_master(path: Path | None = None) -> list[dict[str, Any]]:
    """Rows of the WinTeam job master export (utf-8-sig CSV) as cleaned dicts; [] when absent."""
    path = path or data_dir() / JOB_MASTER_FILE
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            number = _clean(row.get("JobNumber"))
            if not number:
                continue
            parent = _clean(row.get("ParentJobNumber"))
            if parent and parent.endswith(".0"):
                parent = parent[:-2]
            out.append(
                {
                    "job_number": number,
                    "job_name": _clean(row.get("JobDescription")),
                    "tiers": {i: _clean(row.get(f"Tier{i}_Description")) for i in range(1, 8)},
                    "active": rules.parse_flag(row.get("Active")),
                    "address_line_1": _clean(row.get("JobAddress1")),
                    "address_line_2": _clean(row.get("JobAddress2")),
                    "city": _clean(row.get("JobCity")),
                    "state": (_clean(row.get("JobState")) or "").upper() or None,
                    "postal_code": _clean(row.get("JobZip")),
                    "type_id": rules.parse_number(row.get("TypeID")),
                    "type_description": _clean(row.get("TypeDescription")),
                    "date_discontinued": rules.parse_export_date(_clean(row.get("DiscontinueDate"))),
                    "date_to_start": rules.parse_export_date(_clean(row.get("DateToStart"))),
                    "date_entered": rules.parse_export_date(_clean(row.get("DateEntered"))),
                    "company_number": rules.parse_number(row.get("CompanyNumber")),
                    "company_name": _clean(row.get("CompanyName")),
                    "parent_job_number": parent,
                    "supervisor_id": rules.parse_number(row.get("SupervisorID")),
                    "supervisor": _clean(row.get("Supervisor")),
                }
            )
    return out


def read_centroids(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """{'City|ST': {lat, lng, precision}} from sources/geo/city_centroids.json; {} when absent."""
    path = path or data_dir() / CENTROID_FILE
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("Centroid file %s could not be read; coordinates left null", path)
        return {}
    out: dict[str, dict[str, Any]] = {}
    if isinstance(data, dict):
        for key, value in data.items():
            if not isinstance(value, dict):
                continue
            lat, lng = rules.parse_number(value.get("lat")), rules.parse_number(value.get("lng"))
            if lat is None or lng is None or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
                continue
            out[str(key)] = {"lat": lat, "lng": lng, "precision": str(value.get("precision") or "city_center")}
    return out


# ── status ───────────────────────────────────────────────────────────────────
def _reference_summary() -> dict[str, Any] | None:
    if not settings.finance_reference_configured:
        return None
    try:
        with reference_connection() as ref, ref.cursor() as cursor:
            cursor.execute(
                """
                SELECT (SELECT min(period_id) FROM mart.job_profitability_monthly) AS jc_from,
                       (SELECT max(period_id) FROM mart.job_profitability_monthly) AS jc_to,
                       (SELECT max(work_date) FROM core.fact_timekeeping_detail_line) AS timekeeping_max_date,
                       (SELECT max(snapshot_date) FROM core.fact_ar_aging_snapshot_line) AS ar_snapshot_date,
                       (SELECT max(snapshot_date) FROM core.fact_ap_vendor_aging_snapshot_line) AS ap_snapshot_date
                """
            )
            row = cursor.fetchone() or {}
    except (psycopg.Error, RuntimeError) as exc:
        logger.warning("finance_reference status unavailable: %s", exc.__class__.__name__)
        return {"error": exc.__class__.__name__}
    return {
        "job_cost_months": [
            jsonable(rules.period_to_month(row.get("jc_from"))),
            jsonable(rules.period_to_month(row.get("jc_to"))),
        ],
        "timekeeping_max_date": jsonable(row.get("timekeeping_max_date")),
        "ar_snapshot_date": jsonable(row.get("ar_snapshot_date")),
        "ap_snapshot_date": jsonable(row.get("ap_snapshot_date")),
    }


def last_load() -> dict[str, Any] | None:
    """The most recent 'load' run and the per-table runs it spawned."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, status, started_at, completed_at, records_fetched, records_inserted, error_message
            FROM ops.integration_sync_run
            WHERE integration_name = %s AND resource_name = 'load'
            ORDER BY started_at DESC LIMIT 1
            """,
            (INTEGRATION,),
        )
        parent = cursor.fetchone()
        if parent is None:
            return None
        cursor.execute(
            """
            SELECT resource_name, status, records_fetched, records_inserted, completed_at, error_message
            FROM ops.integration_sync_run
            WHERE integration_name = %s AND resource_name <> 'load'
              AND started_at >= %s AND (%s::timestamptz IS NULL OR started_at <= %s::timestamptz)
            ORDER BY started_at
            """,
            (INTEGRATION, parent["started_at"], parent["completed_at"], parent["completed_at"]),
        )
        tables = [
            {"name": r["resource_name"], "rows": r["records_inserted"], "fetched": r["records_fetched"], "status": r["status"],
             "error_message": r["error_message"]}
            for r in cursor.fetchall()
        ]
    return {
        "run_id": str(parent["id"]),
        "status": parent["status"],
        "started_at": jsonable(parent["started_at"]),
        "completed_at": jsonable(parent["completed_at"]),
        "error_message": parent["error_message"],
        "tables": tables,
    }


def status() -> dict[str, Any]:
    """GET /integrations/finance-reference."""
    return {
        "configured": settings.finance_reference_configured,
        "database_host": settings.finance_reference_database_host,
        "reference": _reference_summary(),
        "last_load": last_load(),
        "primary_source": read_primary_source(),
    }


def read_primary_source() -> str:
    try:
        value = _read_setting_standalone("primary_source")
    except psycopg.Error:
        return "none"
    return value if isinstance(value, str) and value else "none"


def _read_setting_standalone(key: str) -> Any:
    with connection() as conn:
        return _setting(conn, key, None)


# ── step: reset ──────────────────────────────────────────────────────────────
def reset_warehouse(conn: Any) -> dict[str, int]:
    """Remove the previous finance_reference load; returns the rows cleared per table.

    Rules (see RESET_* above and docs/finance-reference-source.md "Reset"):
      * fact tables: DELETE ... WHERE source = 'finance_reference' only;
      * dimensions: reference-only rows (source = 'finance_reference') are deleted; rows the API has
        taken over keep their GUID / coordinates and receive the reference attributes on reload.
        core.dim_parent_account has no source column: accounts no current dimension row points at
        any more are removed (the loader re-creates its own);
      * mart tables are emptied (TRUNCATE ... CASCADE; forecast tables cascade from
        forecast_run_meta) and refilled by marts.rebuild_all at the end of the load;
      * raw.winteam_record, ops.source_watermark, ops.app_setting, ops.integration_sync_run and
        mart.rebuild_log are never touched, and no row with source = 'winteam_api' is.
    """
    cleared: dict[str, int] = {}
    with conn.cursor() as cursor:
        cursor.execute(f"TRUNCATE {', '.join(RESET_MART_TABLES)} CASCADE")
        for table in RESET_MART_TABLES:
            cleared[table] = -1  # emptied; rebuilt by marts.rebuild_all
        for table in RESET_FACT_TABLES:
            cursor.execute(f"DELETE FROM {table} WHERE source = %(source)s", {"source": SOURCE})
            cleared[table] = int(cursor.rowcount or 0)
        for fact, fk, dim, key in _FK_TO_DIM:
            cursor.execute(
                f"UPDATE {fact} f SET {fk} = NULL WHERE f.source <> %(source)s AND f.{fk} IN "
                f"(SELECT d.{key} FROM {dim} d WHERE d.source = %(source)s)",
                {"source": SOURCE},
            )
        for table in RESET_DIM_TABLES:
            cursor.execute(f"DELETE FROM {table} WHERE source = %(source)s", {"source": SOURCE})
            cleared[table] = int(cursor.rowcount or 0)
        cursor.execute(
            """
            DELETE FROM core.dim_parent_account a
            WHERE NOT EXISTS (SELECT 1 FROM core.dim_job j WHERE j.parent_account_key = a.parent_account_key)
              AND NOT EXISTS (SELECT 1 FROM core.dim_customer c WHERE c.parent_account_key = a.parent_account_key)
            """
        )
        cleared["core.dim_parent_account"] = int(cursor.rowcount or 0)
    logger.info("finance_reference reset cleared %s", {k: v for k, v in cleared.items() if v})
    return cleared


# ── step: settings ───────────────────────────────────────────────────────────
def load_settings(conn: Any, config: dict[str, Any]) -> dict[str, Any]:
    groups = [g for g in (config.get("account_groups") or []) if isinstance(g, dict)]
    treatment = [r for r in (config.get("ar_treatment_rules") or []) if isinstance(r, dict)]
    _upsert_setting(
        conn, "account_groups", groups,
        "Parent account grouping rules: [{name, terms:[], customer_terms:[], job_numbers:[]}], matched against job names and AR customer names (case-insensitive contains). Loaded from the Finance_Dashboard platform config.",
    )
    _upsert_setting(
        conn, "ar_treatment_rules", treatment,
        "Customers matched by these regexes ([{match, treatment, include_collectible_ar}]) are excluded from collectible AR (intercompany/settlement balances).",
    )
    _upsert_setting(
        conn, "job_tier_map", REAL_JOB_TIER_MAP,
        "Which WinTeam job tier id populates each dashboard dimension. Tenant specific; confirm in WinTeam job setup.",
    )
    return {"account_groups": len(groups), "ar_treatment_rules": len(treatment), "job_tier_map": REAL_JOB_TIER_MAP}


# ── step: stage ──────────────────────────────────────────────────────────────
def stage_reference(conn: Any, ref: Any) -> dict[str, int]:
    """COPY the reference tables into TEMP tables on the application connection."""
    counts: dict[str, int] = {}
    with conn.cursor() as dst_cur, ref.cursor() as src_cur:
        for name, (columns, query) in STAGED.items():
            dst_cur.execute(f"CREATE TEMP TABLE {name} ({columns})")
            with src_cur.copy(f"COPY ({query}) TO STDOUT") as src, dst_cur.copy(f"COPY {name} FROM STDIN") as dst:
                for block in src:
                    dst.write(block)
            dst_cur.execute(f"SELECT count(*) AS n FROM {name}")
            counts[name] = int(dst_cur.fetchone()["n"])
        dst_cur.execute("CREATE INDEX ON fr_timekeeping (work_date)")
        dst_cur.execute("CREATE INDEX ON fr_ar_aging (snapshot_date)")
        dst_cur.execute("CREATE INDEX ON fr_ap_aging (snapshot_date)")
        dst_cur.execute("ANALYZE fr_timekeeping")
    return counts


def read_platform_config(ref: Any) -> dict[str, Any]:
    with ref.cursor() as cursor:
        cursor.execute("SELECT config_json FROM app.platform_config ORDER BY 1 LIMIT 1")
        row = cursor.fetchone()
    value = row["config_json"] if row else {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = {}
    return value if isinstance(value, dict) else {}


# ── step: dim_job ────────────────────────────────────────────────────────────
def _fetch_all(conn: Any, sql: str, params: Any = None) -> list[dict[str, Any]]:
    with conn.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def build_jobs(conn: Any, config: dict[str, Any], aliases: dict[str, str], job_master: list[dict[str, Any]],
               centroids: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Assemble core.dim_parent_account, core.dim_job and core.job_tier from every job source."""
    groups = [g for g in (config.get("account_groups") or []) if isinstance(g, dict)]
    verticals = [v for v in (config.get("verticals") or []) if isinstance(v, dict)]

    jobs: dict[str, dict[str, Any]] = {}

    def job(number: str) -> dict[str, Any]:
        return jobs.setdefault(number, {"job_number": number, "job_name": None, "company_name_raw": None, "is_self_perform": None})

    # 1. Reference dim_job (CFO-curated is_self_perform, company attributes).
    for r in _fetch_all(conn, "SELECT job_number, name, is_self_perform, attributes FROM fr_job"):
        number = _clean(r["job_number"])
        if not number:
            continue
        attrs = r["attributes"] if isinstance(r["attributes"], dict) else {}
        j = job(number)
        j["job_name"] = _clean(r["name"]) or j["job_name"]
        j["company_name_raw"] = _clean(attrs.get("company_name")) or j["company_name_raw"]
        j["is_self_perform"] = r["is_self_perform"] if r["is_self_perform"] is not None else j["is_self_perform"]

    # 2. Job file lines (job description + company); a job number shared by both databases keeps
    #    the reference dim_job's choice and is reported as a collision.
    collisions: dict[str, list[str]] = defaultdict(list)
    for r in _fetch_all(conn, "SELECT p->>'job_number' AS job_number, p->>'company_name' AS company_name, p->>'job_description' AS job_description FROM fr_job_file"):
        number = _clean(r["job_number"])
        if not number:
            continue
        j = job(number)
        raw = _clean(r["company_name"])
        if j["company_name_raw"] and raw and rules.namespace_for(raw) != rules.namespace_for(j["company_name_raw"]):
            collisions[number].append(f"{raw} => {_clean(r['job_description'])}")
            continue
        j["job_name"] = j["job_name"] or _clean(r["job_description"])
        j["company_name_raw"] = j["company_name_raw"] or raw

    # 3. Jobs only known from facts (job cost, timekeeping, AR): keep them so their facts reach the marts.
    for r in _fetch_all(conn, "SELECT DISTINCT ON (job_number) job_number, job_name FROM fr_job_cost ORDER BY job_number, period_id DESC"):
        number = _clean(r["job_number"])
        if number:
            j = job(number)
            j["job_name"] = j["job_name"] or _clean(r["job_name"])
    tk_company = _fetch_all(
        conn,
        "SELECT job_number, company_name, job_description FROM (SELECT p->>'job_number' AS job_number, p->>'company_name' AS company_name, "
        "max(p->>'job_description') AS job_description, count(*) AS n, row_number() OVER (PARTITION BY p->>'job_number' ORDER BY count(*) DESC) AS rn "
        "FROM fr_timekeeping GROUP BY 1, 2) x WHERE rn = 1",
    )
    for r in tk_company:
        number = _clean(r["job_number"])
        if number:
            j = job(number)
            j["job_name"] = j["job_name"] or _clean(r["job_description"])
            j["company_name_raw"] = j["company_name_raw"] or _clean(r["company_name"])
            j["tk_company_raw"] = _clean(r["company_name"])

    # 4. AR customers per job (most frequent, namespace-aware) from the register and the aging snapshots.
    customer_rows = _fetch_all(
        conn,
        f"""
        SELECT ns, job_number, customer_number, customer_name, parent_customer_number, parent_customer_name, sum(n) AS n FROM (
          SELECT {_ns("p->>'company_name'", 'batch_company')} AS ns, {_txt('service_location_job_number')} AS job_number,
                 {_txt('customer_number')} AS customer_number, {_txt('customer_name')} AS customer_name,
                 {_txt('parent_customer_number')} AS parent_customer_number, {_txt('parent_customer_name')} AS parent_customer_name, count(*) AS n
          FROM fr_ar_register GROUP BY 1, 2, 3, 4, 5, 6
          UNION ALL
          SELECT {_ns("p->>'company_name'", 'batch_company')}, {_txt('service_location_job_number')}, {_txt('customer_number')}, {_txt('customer_name')},
                 {_txt('parent_customer_number')}, {_txt('parent_customer_name')}, count(*)
          FROM fr_ar_aging GROUP BY 1, 2, 3, 4, 5, 6
        ) x WHERE job_number IS NOT NULL AND customer_number IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, sum(n) DESC
        """,
    )
    customers_by_job: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in customer_rows:
        customers_by_job[(r["ns"], r["job_number"])].append(r)
        job(r["job_number"])  # a job billed but absent from every master still gets a dimension row

    overrides = {_clean(r["job_number"]): r for r in _fetch_all(conn, "SELECT * FROM fr_overrides") if _clean(r["job_number"])}
    master = {m["job_number"]: m for m in job_master}
    today = date.today()

    parent_accounts: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    tier_rows: list[tuple[str, int, str]] = []
    stats: Counter = Counter()

    for number, j in sorted(jobs.items()):
        raw_company = j.get("company_name_raw")
        namespace = rules.namespace_for(raw_company)
        # The job master is a Crane export: never apply it to a Sarus job that shares the number.
        m = master.get(number) if namespace == rules.NAMESPACE_CRANE else None
        if m is not None:
            raw_company = raw_company or m.get("company_name")
            j["job_name"] = j["job_name"] or m.get("job_name")
            stats["jobs_with_job_master"] += 1
        company = rules.alias_company(raw_company, aliases)
        override = overrides.get(number, {})

        customers = customers_by_job.get((namespace, number), [])
        top = customers[0] if customers else {}
        customer_names = [c.get("customer_name") for c in customers] + [c.get("parent_customer_name") for c in customers]

        group = rules.match_account_group(
            job_number=number, job_name=j["job_name"], customer_names=customer_names, groups=groups,
            override=override.get("assigned_account_group"),
        )
        if group:
            account_name, account_id = group, f"fr:group:{group}"
            stats["jobs_in_account_group"] += 1
        else:
            fallback = override.get("assigned_client_name") or top.get("parent_customer_name") or top.get("customer_name")
            if fallback:
                account_name, account_id = str(fallback).strip(), f"fr:customer:{str(fallback).strip()}"
                stats["jobs_with_customer_account"] += 1
            else:
                account_name, account_id = "Other", "fr:group:Other"
                stats["jobs_in_other"] += 1
        parent_accounts.setdefault(account_id, {"winteam_id": account_id, "account_name": account_name})

        tiers = (m or {}).get("tiers") or {}
        state = (m or {}).get("state")
        region = tiers.get(3) or rules.region_for_state(state)
        branch = tiers.get(1)
        service_type = tiers.get(4)
        manager = tiers.get(7)
        vertical = rules.match_vertical(j["job_name"], customer_names, verticals) or service_type

        if override.get("is_self_perform_override") is not None:
            self_perform = bool(override["is_self_perform_override"])
        else:
            self_perform = j.get("is_self_perform")
        delivery_model = None if self_perform is None else ("self_perform" if self_perform else "subcontracted")

        active = True
        date_discontinued = (m or {}).get("date_discontinued")
        if m is not None:
            active = (m.get("active") is not False) and not (date_discontinued and date_discontinued <= today)
        if not active:
            stats["jobs_inactive"] += 1

        lat = lng = None
        precision = None
        key = rules.centroid_key((m or {}).get("city"), state)
        if key and key in centroids:
            lat, lng = centroids[key]["lat"], centroids[key]["lng"]
            precision = "city_center"
            stats["jobs_with_centroid"] += 1

        rows.append(
            {
                "winteam_id": number, "job_number": number, "job_name": j["job_name"], "account_id": account_id,
                "status": "active" if active else "inactive", "service_type": service_type, "branch_name": branch,
                "region_name": region, "manager_name": manager, "vertical": vertical,
                "address_line_1": (m or {}).get("address_line_1"), "address_line_2": (m or {}).get("address_line_2"),
                "city": (m or {}).get("city"), "state_province": state, "postal_code": (m or {}).get("postal_code"),
                "country_code": rules.country_for_state(state) if state else None,
                "latitude": lat, "longitude": lng, "geo_precision": precision,
                "company_number": int((m or {}).get("company_number") or 0) or None,
                "parent_job_number": (m or {}).get("parent_job_number"),
                "type_id": int((m or {}).get("type_id") or 0) or None,
                "supervisor_id": int((m or {}).get("supervisor_id") or 0) or None,
                "date_to_start": (m or {}).get("date_to_start"), "date_discontinued": date_discontinued,
                "is_active": active, "company": company, "company_name_raw": raw_company,
                "delivery_model": delivery_model, "account_group": group,
                "customer_number": top.get("customer_number"), "customer_name": top.get("customer_name"),
                "tiers": Jsonb([{"tierID": i, "tierValueDescription": v} for i, v in sorted(tiers.items()) if v]),
                "custom_fields": Jsonb([{"name": "TypeDescription", "value": (m or {}).get("type_description")}] if m and m.get("type_description") else []),
            }
        )
        for tier_id, value in tiers.items():
            if value:
                tier_rows.append((number, tier_id, value))

    with conn.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO core.dim_parent_account (winteam_id, account_name, active) VALUES (%(winteam_id)s, %(account_name)s, true) "
            "ON CONFLICT (winteam_id) DO UPDATE SET account_name = excluded.account_name, active = true, warehouse_updated_at = now()",
            list(parent_accounts.values()),
        )
        cursor.executemany(
            """
            INSERT INTO core.dim_job (
              winteam_id, identity_version, parent_account_key, job_number, job_name, status, service_type, branch_name, region_name,
              manager_name, vertical, address_line_1, address_line_2, city, state_province, postal_code, country_code, latitude, longitude,
              company_number, parent_job_number, type_id, supervisor_id, date_to_start, tiers, custom_fields, is_active, last_seen_at,
              source, company, company_name_raw, delivery_model, account_group, customer_number, customer_name, geo_precision, date_discontinued
            ) VALUES (
              %(winteam_id)s, 1, (SELECT parent_account_key FROM core.dim_parent_account WHERE winteam_id = %(account_id)s),
              %(job_number)s, %(job_name)s, %(status)s, %(service_type)s, %(branch_name)s, %(region_name)s, %(manager_name)s, %(vertical)s,
              %(address_line_1)s, %(address_line_2)s, %(city)s, %(state_province)s, %(postal_code)s, %(country_code)s, %(latitude)s, %(longitude)s,
              %(company_number)s, %(parent_job_number)s, %(type_id)s, %(supervisor_id)s, %(date_to_start)s, %(tiers)s, %(custom_fields)s,
              %(is_active)s, now(), 'finance_reference', %(company)s, %(company_name_raw)s, %(delivery_model)s, %(account_group)s,
              %(customer_number)s, %(customer_name)s, %(geo_precision)s, %(date_discontinued)s
            )
            ON CONFLICT (job_number) WHERE valid_to IS NULL DO UPDATE SET
              -- the current row survived the reset because the live API owns it (source 'winteam_api'):
              -- the reference fills only what the API did not supply and the reference-only columns
              parent_account_key = coalesce(core.dim_job.parent_account_key, excluded.parent_account_key),
              job_name = coalesce(core.dim_job.job_name, excluded.job_name),
              service_type = coalesce(core.dim_job.service_type, excluded.service_type),
              branch_name = coalesce(core.dim_job.branch_name, excluded.branch_name),
              region_name = coalesce(core.dim_job.region_name, excluded.region_name),
              manager_name = coalesce(core.dim_job.manager_name, excluded.manager_name),
              vertical = coalesce(core.dim_job.vertical, excluded.vertical),
              address_line_1 = coalesce(core.dim_job.address_line_1, excluded.address_line_1),
              address_line_2 = coalesce(core.dim_job.address_line_2, excluded.address_line_2),
              city = coalesce(core.dim_job.city, excluded.city),
              state_province = coalesce(core.dim_job.state_province, excluded.state_province),
              postal_code = coalesce(core.dim_job.postal_code, excluded.postal_code),
              country_code = coalesce(core.dim_job.country_code, excluded.country_code),
              latitude = CASE WHEN core.dim_job.geo_precision = 'exact' THEN core.dim_job.latitude ELSE coalesce(excluded.latitude, core.dim_job.latitude) END,
              longitude = CASE WHEN core.dim_job.geo_precision = 'exact' THEN core.dim_job.longitude ELSE coalesce(excluded.longitude, core.dim_job.longitude) END,
              geo_precision = CASE WHEN core.dim_job.geo_precision = 'exact' THEN 'exact' ELSE coalesce(excluded.geo_precision, core.dim_job.geo_precision) END,
              company_number = coalesce(core.dim_job.company_number, excluded.company_number),
              parent_job_number = coalesce(core.dim_job.parent_job_number, excluded.parent_job_number),
              type_id = coalesce(core.dim_job.type_id, excluded.type_id),
              supervisor_id = coalesce(core.dim_job.supervisor_id, excluded.supervisor_id),
              date_to_start = coalesce(core.dim_job.date_to_start, excluded.date_to_start),
              tiers = CASE WHEN jsonb_array_length(core.dim_job.tiers) > 0 THEN core.dim_job.tiers ELSE excluded.tiers END,
              custom_fields = CASE WHEN jsonb_array_length(core.dim_job.custom_fields) > 0 THEN core.dim_job.custom_fields ELSE excluded.custom_fields END,
              company = coalesce(core.dim_job.company, excluded.company),
              company_name_raw = excluded.company_name_raw,
              delivery_model = excluded.delivery_model,
              account_group = excluded.account_group,
              customer_number = excluded.customer_number,
              customer_name = excluded.customer_name,
              date_discontinued = excluded.date_discontinued,
              warehouse_updated_at = now()
            """,
            rows,
        )
        cursor.executemany(
            """
            INSERT INTO core.job_tier (job_key, tier_id, tier_description)
            SELECT job_key, %s, %s FROM core.dim_job WHERE job_number = %s AND valid_to IS NULL
            ON CONFLICT (job_key, tier_id) DO UPDATE SET tier_description = excluded.tier_description
            """,
            [(tier_id, value, number) for number, tier_id, value in tier_rows],
        )
        cursor.execute(
            """
            UPDATE core.dim_parent_account a SET vertical = s.vertical, warehouse_updated_at = now()
            FROM (SELECT parent_account_key, mode() WITHIN GROUP (ORDER BY vertical) AS vertical
                  FROM core.dim_job WHERE valid_to IS NULL AND vertical IS NOT NULL AND parent_account_key IS NOT NULL
                  GROUP BY parent_account_key) s
            WHERE s.parent_account_key = a.parent_account_key
            """
        )
    stats["jobs"] = len(rows)
    stats["parent_accounts"] = len(parent_accounts)
    stats["job_number_collisions"] = len(collisions)
    return {"rows": len(rows), "stats": dict(stats), "collisions": {k: v for k, v in sorted(collisions.items())}}


# ── step: job cost ───────────────────────────────────────────────────────────
def load_job_cost(conn: Any) -> int:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO core.fact_job_cost_month (
              source, job_number, month, job_name, company, revenue, direct_labor, payroll_taxes_insurance, materials, subcontractors,
              equipment_supplies, other_direct_costs, total_direct_costs, gross_profit, budget_revenue, budget_direct_costs, budget_labor,
              budget_hours, actual_hours, overtime_hours, data_quality_status, confidence_score, exception_count, lineage
            )
            SELECT 'finance_reference', jc.job_number, make_date(jc.period_id / 100, mod(jc.period_id, 100), 1), jc.job_name, d.company,
                   coalesce(jc.revenue, 0), coalesce(jc.direct_labor, 0), coalesce(jc.payroll_taxes_insurance, 0), coalesce(jc.materials, 0),
                   coalesce(jc.subcontractors, 0), coalesce(jc.equipment_supplies, 0), coalesce(jc.other_direct_costs, 0),
                   coalesce(jc.total_direct_costs, 0), coalesce(jc.gross_profit, 0),
                   nullif(jc.budget_revenue, 0), nullif(jc.budget_direct_costs, 0), NULL, nullif(jc.budget_hours, 0),
                   jc.actual_hours, jc.overtime_hours,
                   CASE WHEN jc.data_quality_status = 'warning' THEN 'warning' ELSE 'passed' END,
                   jc.confidence_score, jc.exception_count, coalesce(jc.lineage, '{}'::jsonb)
            FROM fr_job_cost jc
            LEFT JOIN core.dim_job d ON d.job_number = jc.job_number AND d.valid_to IS NULL
            WHERE jc.job_number IS NOT NULL AND jc.period_id BETWEEN 190001 AND 299912
            ON CONFLICT (source, job_number, month) DO NOTHING
            """
        )
        return cursor.rowcount


# ── step: labor budget ───────────────────────────────────────────────────────
def load_labor_budget(conn: Any, aliases: dict[str, str]) -> dict[str, Any]:
    """daily_budget monthly sums -> hours budget comparison (rules.hbc_job_budget) -> wage-by-job budget."""
    params = {"aliases": Jsonb(aliases)}
    inconsistent: list[str] = []
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            INSERT INTO core.fact_labor_budget_month (source, job_number, month, company, budget_labor, budget_hours, basis)
            SELECT 'finance_reference', job_number, date_trunc('month', budget_date)::date,
                   {_alias('max(company_name)')}, sum(budgeted_dollars), sum(budgeted_hours), 'daily_budget'
            FROM fr_daily_budget
            WHERE job_number IS NOT NULL
            GROUP BY job_number, date_trunc('month', budget_date)
            HAVING sum(budgeted_dollars) > 0
            """,
            params,
        )
        daily = cursor.rowcount

        # HBC: the job's monthly budget sits on one employee row per job (max, never sum); see rules.hbc_job_budget.
        cursor.execute(
            f"""
            SELECT {_ns('batch_company')} AS ns, {_txt('job_number')} AS job_number, period_id,
                   p->>'bud_labor_dollars' AS bud_labor_dollars, p->>'total_daily_budgeted_hours' AS total_daily_budgeted_hours
            FROM fr_hbc WHERE {_txt('job_number')} IS NOT NULL
            """
        )
        grouped: dict[tuple[str, str, int], list[dict[str, Any]]] = defaultdict(list)
        for r in cursor.fetchall():
            grouped[(r["ns"], r["job_number"], int(r["period_id"]))].append(r)
        hbc_rows: dict[tuple[str, date], dict[str, float | None]] = {}
        for (ns, number, period), group_rows in grouped.items():
            budget, hours, consistent = rules.hbc_job_budget(group_rows)
            if not consistent:
                inconsistent.append(f"{ns}:{number}:{period}")
            if not budget:
                continue
            month = rules.period_to_month(period)
            if month is None:
                continue
            slot = hbc_rows.setdefault((number, month), {"budget": 0.0, "hours": 0.0, "ns": ns})
            slot["budget"] = (slot["budget"] or 0.0) + budget          # job numbers shared by both databases add up (documented)
            slot["hours"] = (slot["hours"] or 0.0) + (hours or 0.0)
        cursor.executemany(
            """
            INSERT INTO core.fact_labor_budget_month (source, job_number, month, company, budget_labor, budget_hours, basis)
            SELECT 'finance_reference', %(job_number)s, %(month)s, d.company, %(budget)s, nullif(%(hours)s, 0), 'hours_budget_comparison'
            FROM (SELECT 1) one
            LEFT JOIN core.dim_job d ON d.job_number = %(job_number)s AND d.valid_to IS NULL
            ON CONFLICT (source, job_number, month) DO NOTHING
            """,
            [{"job_number": n, "month": m, "budget": round(v["budget"] or 0, 2), "hours": round(v["hours"] or 0, 2)} for (n, m), v in hbc_rows.items()],
        )
        cursor.execute("SELECT count(*) AS n FROM core.fact_labor_budget_month WHERE basis = 'hours_budget_comparison'")
        hbc = int(cursor.fetchone()["n"])

        # Wage-by-job: total_budget_labor_dollars is carried once per job/period (verified: one row per non-zero value).
        cursor.execute(
            f"""
            INSERT INTO core.fact_labor_budget_month (source, job_number, month, company, budget_labor, budget_hours, basis)
            SELECT 'finance_reference', w.job_number, make_date(w.period_id / 100, mod(w.period_id, 100), 1),
                   max(d.company), sum(w.budget), NULL, 'wage_by_job'
            FROM (
              SELECT {_ns("p->>'company_name'", 'batch_company')} AS ns, {_txt('job_number')} AS job_number, period_id,
                     max({_num('total_budget_labor_dollars')}) AS budget
              FROM fr_wage WHERE {_txt('job_number')} IS NOT NULL AND period_id BETWEEN 190001 AND 299912
              GROUP BY 1, 2, 3
            ) w
            LEFT JOIN core.dim_job d ON d.job_number = w.job_number AND d.valid_to IS NULL
            GROUP BY w.job_number, w.period_id
            HAVING sum(w.budget) > 0
            ON CONFLICT (source, job_number, month) DO NOTHING
            """
        )
        wage = cursor.rowcount
        cursor.execute(
            """
            UPDATE core.fact_job_cost_month jc SET budget_labor = lb.budget_labor
            FROM core.fact_labor_budget_month lb
            WHERE lb.source = jc.source AND lb.job_number = jc.job_number AND lb.month = jc.month
            """
        )
        linked = cursor.rowcount
    return {"daily_budget": daily, "hours_budget_comparison": hbc, "wage_by_job": wage, "job_cost_rows_with_budget": linked,
            "hbc_inconsistent_groups": inconsistent[:50], "hbc_inconsistent_count": len(inconsistent)}


# ── step: daily budget and contract billing (executive weekly P&L inputs) ────
def load_daily_budget(conn: Any, aliases: dict[str, str]) -> int:
    """core.fact_daily_budget: one row per (job, day), the latest reference import per day winning.

    Job numbers are carried as exported (the daily budget export exists for the Crane databases
    only, so no Sarus namespacing applies); company is the aliased export company name.
    """
    params = {"aliases": Jsonb(aliases)}
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            INSERT INTO core.fact_daily_budget (source, job_number, budget_date, company, budgeted_dollars, budgeted_hours)
            SELECT DISTINCT ON (job_number, budget_date)
                   'finance_reference', job_number, budget_date, {_alias('company_name')},
                   coalesce(budgeted_dollars, 0), coalesce(budgeted_hours, 0)
            FROM fr_daily_budget
            WHERE job_number IS NOT NULL
            ORDER BY job_number, budget_date, created_at DESC NULLS LAST
            ON CONFLICT (source, job_number, budget_date) DO NOTHING
            """,
            params,
        )
        return cursor.rowcount


def load_contract_billing(conn: Any, ref: Any) -> dict[str, Any]:
    """core.contract_billing from the reference app.contract_billing (admin-maintained monthly contract rates).

    The table is optional in the reference database (the restored dump predates it); when absent the
    step records `present: false` and the weekly invoicing falls through to job-cost / AR bases.
    """
    with ref.cursor() as src:
        src.execute("SELECT to_regclass('app.contract_billing') AS t")
        present = (src.fetchone() or {}).get("t") is not None
        rows: list[dict[str, Any]] = []
        if present:
            src.execute("SELECT job_number, effective_month, monthly_amount FROM app.contract_billing WHERE job_number IS NOT NULL")
            rows = src.fetchall()
    inserted = 0
    with conn.cursor() as cursor:
        for r in rows:
            month = rules.parse_export_date(r["effective_month"]) if isinstance(r["effective_month"], str) else r["effective_month"]
            amount = rules.parse_number(r["monthly_amount"])
            if month is None or amount is None:
                continue
            cursor.execute(
                """
                INSERT INTO core.contract_billing (source, job_number, effective_month, company, monthly_amount)
                SELECT 'finance_reference', %(job_number)s, %(month)s, d.company, %(amount)s
                FROM (SELECT 1) one
                LEFT JOIN core.dim_job d ON d.job_number = %(job_number)s AND d.valid_to IS NULL
                ON CONFLICT (source, job_number, effective_month) DO NOTHING
                """,
                {"job_number": str(r["job_number"]).strip(), "month": month.replace(day=1), "amount": round(amount, 2)},
            )
            inserted += cursor.rowcount
    return {"present": present, "reference_rows": len(rows), "rows": inserted}


# ── step: timekeeping ────────────────────────────────────────────────────────
def load_timekeeping(conn: Any, aliases: dict[str, str]) -> int:
    params = {"aliases": Jsonb(aliases)}
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            INSERT INTO core.fact_timekeeping (
              winteam_id, job_key, job_number, employee_source_id, employee_name, work_date, hours, regular_hours, overtime_hours,
              double_time_hours, labor_cost, labor_cost_basis, category_detail_id, hours_type, rate, in_time, out_time, lunch,
              work_ticket_number, pay_week_start, overtime_basis, source, company, warehouse_loaded_at
            )
            SELECT
              coalesce('tk:' || x.tk_hours_id, 'row:' || x.id::text),
              d.job_key, x.job_number, x.employee, x.employee_name, x.work_date,
              x.hours, greatest(coalesce(x.regular, 0), 0), greatest(coalesce(x.ot, 0), 0), greatest(coalesce(x.dt, 0), 0),
              NULL, 'none', x.hours_type_id, x.hours_type, NULL,
              x.in_ts,
              CASE WHEN x.out_ts IS NOT NULL AND x.in_ts IS NOT NULL AND x.out_ts < x.in_ts THEN x.out_ts + interval '1 day' ELSE x.out_ts END,
              x.lunch, x.work_ticket, x.work_date - extract(dow FROM x.work_date)::int, 'category', 'finance_reference', x.company, now()
            FROM (
              SELECT id, work_date,
                     {_txt('tk_hours_id')} AS tk_hours_id,
                     {_txt('job_number')} AS job_number,
                     {_txt('employee_number')} AS employee,
                     {_txt('employee_name')} AS employee_name,
                     coalesce({_num('total_hours')}, {_num('hours')}) AS hours,
                     coalesce({_num('regular_hours')}, coalesce({_num('total_hours')}, {_num('hours')}) - coalesce({_num('overtime_hours')}, 0) - coalesce({_num('double_time_hours')}, 0)) AS regular,
                     {_num('overtime_hours')} AS ot,
                     {_num('double_time_hours')} AS dt,
                     {_int('hours_type_id')} AS hours_type_id,
                     {_txt('hours_type_description')} AS hours_type,
                     CASE WHEN p->>'in_time' ~ '{HHMM_RE}' THEN (work_date + (p->>'in_time')::time)::timestamptz END AS in_ts,
                     CASE WHEN p->>'out_time' ~ '{HHMM_RE}' THEN (work_date + (p->>'out_time')::time)::timestamptz END AS out_ts,
                     {_num('lunch')} AS lunch,
                     {_txt('work_ticket_number')} AS work_ticket,
                     {_alias("coalesce(p->>'company_name', batch_company)")} AS company
              FROM fr_timekeeping
            ) x
            LEFT JOIN core.dim_job d ON d.job_number = x.job_number AND d.valid_to IS NULL
            WHERE x.job_number IS NOT NULL AND x.hours IS NOT NULL
            ON CONFLICT (winteam_id) DO NOTHING
            """,
            params,
        )
        return cursor.rowcount


def apply_trailing_rates(conn: Any, lag_days: int, today: date | None = None) -> dict[str, Any]:
    """labor_cost = hours x trailing job rate (rules.trailing_rate); company / portfolio fallbacks."""
    today = today or date.today()
    rows = _fetch_all(conn, "SELECT job_number, company, month, direct_labor, actual_hours FROM core.fact_job_cost_month WHERE source = 'finance_reference'")
    by_job: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        r["closed"] = _is_closed(r["month"], lag_days, today)
        by_job[r["job_number"]].append(r)

    def pooled_rate(subset: Iterable[dict[str, Any]]) -> float | None:
        usable = [r for r in subset if r["closed"] and float(r["actual_hours"] or 0) > 0 and float(r["direct_labor"] or 0) > 0]
        months = sorted({r["month"] for r in usable}, reverse=True)[: rules.TRAILING_RATE_MONTHS]
        recent = [r for r in usable if r["month"] in months]
        hours = sum(float(r["actual_hours"]) for r in recent)
        labor = sum(float(r["direct_labor"]) for r in recent)
        return labor / hours if hours > 0 and labor > 0 else None

    companies = sorted({r["company"] for r in rows if r["company"]})
    company_rates = {c: pooled_rate(r for r in rows if r["company"] == c) for c in companies}
    portfolio_rate = pooled_rate(rows)

    job_rates: list[tuple[str, float, str]] = []
    basis_counts: Counter = Counter()
    for number, months in by_job.items():
        company = next((r["company"] for r in months if r["company"]), None)
        rate, basis = rules.trailing_rate(months, company_rate=company_rates.get(company), portfolio_rate=portfolio_rate)
        if rate is not None:
            job_rates.append((number, round(rate, 4), basis))
            basis_counts[basis] += 1

    with conn.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE IF NOT EXISTS fr_job_rate (job_number text PRIMARY KEY, rate numeric, basis text)")
        cursor.execute("TRUNCATE fr_job_rate")
        cursor.executemany("INSERT INTO fr_job_rate (job_number, rate, basis) VALUES (%s, %s, %s)", job_rates)
        cursor.execute(
            """
            UPDATE core.fact_timekeeping t
            SET rate = r.rate, labor_cost = round(coalesce(t.hours, 0) * r.rate, 2), labor_cost_basis = 'trailing_job_rate'
            FROM fr_job_rate r
            WHERE t.source = 'finance_reference' AND t.job_number = r.job_number
            """
        )
        by_job_rows = cursor.rowcount
        cursor.execute("CREATE TEMP TABLE IF NOT EXISTS fr_company_rate (company text PRIMARY KEY, rate numeric)")
        cursor.execute("TRUNCATE fr_company_rate")
        cursor.executemany(
            "INSERT INTO fr_company_rate (company, rate) VALUES (%s, %s)",
            [(c, round(v, 4)) for c, v in company_rates.items() if v],
        )
        cursor.execute(
            """
            UPDATE core.fact_timekeeping t
            SET rate = r.rate, labor_cost = round(coalesce(t.hours, 0) * r.rate, 2), labor_cost_basis = 'trailing_job_rate'
            FROM fr_company_rate r
            WHERE t.source = 'finance_reference' AND t.labor_cost IS NULL AND t.company = r.company
            """
        )
        by_company_rows = cursor.rowcount
        by_portfolio_rows = 0
        if portfolio_rate:
            cursor.execute(
                """
                UPDATE core.fact_timekeeping t
                SET rate = %(rate)s::numeric, labor_cost = round(coalesce(t.hours, 0) * %(rate)s::numeric, 2), labor_cost_basis = 'trailing_job_rate'
                WHERE t.source = 'finance_reference' AND t.labor_cost IS NULL
                """,
                {"rate": round(portfolio_rate, 4)},
            )
            by_portfolio_rows = cursor.rowcount
        cursor.execute("UPDATE core.fact_timekeeping SET labor_cost_basis = 'none' WHERE source = 'finance_reference' AND labor_cost IS NULL")
        unpriced = cursor.rowcount
    return {
        "rule": f"sum(direct_labor) / sum(actual_hours) over the job's last {rules.TRAILING_RATE_MONTHS} closed job-cost months with hours > 0; "
                "else the company's pooled rate over its last 3 closed months; else the portfolio rate",
        "close_lag_days": lag_days,
        "jobs_with_rate": len(job_rates),
        "job_rate_basis": dict(basis_counts),
        "company_rates": {c: round(v, 4) for c, v in company_rates.items() if v},
        "portfolio_rate": round(portfolio_rate, 4) if portfolio_rate else None,
        "timekeeping_rows_priced": {"job_rate": by_job_rows, "company_rate": by_company_rows, "portfolio_rate": by_portfolio_rows, "unpriced": unpriced},
    }


# ── step: receivables ────────────────────────────────────────────────────────
def _latest_snapshot(conn: Any, table: str) -> date | None:
    with conn.cursor() as cursor:
        cursor.execute(f"SELECT max(snapshot_date) AS d FROM {table}")
        row = cursor.fetchone()
    return row["d"] if row else None


def load_receivables(conn: Any, aliases: dict[str, str], treatment_rules: list[dict[str, Any]]) -> dict[str, Any]:
    """core.dim_customer, core.fact_ar_invoice (one row per invoice) and core.fact_ar_aging_snapshot."""
    params = {"aliases": Jsonb(aliases)}
    latest = _latest_snapshot(conn, "fr_ar_aging")
    default_company = {ns: rules.alias_company(ns, aliases) for ns in (rules.NAMESPACE_CRANE, rules.NAMESPACE_SARUS)}
    job_company = {r["job_number"]: (r["company"], rules.namespace_for(r["company_name_raw"]))
                   for r in _fetch_all(conn, "SELECT job_number, company, company_name_raw FROM core.dim_job WHERE valid_to IS NULL")}

    def resolve_company(raw: str | None, ns: str, job_number: str | None) -> str | None:
        label = rules.alias_company(raw, aliases)
        if label:
            return label
        jc = job_company.get(job_number or "")
        if jc and jc[0] and jc[1] == ns:
            return jc[0]
        return default_company.get(ns)

    # 1. Register rows -> one invoice per (namespace, invoice_number).
    register = _fetch_all(conn, f"SELECT {_ns("p->>'company_name'", 'batch_company')} AS ns, p FROM fr_ar_register WHERE {_txt('invoice_number')} IS NOT NULL")
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in register:
        grouped[(r["ns"], str(r["p"].get("invoice_number")).strip())].append(r["p"])
    invoices: dict[tuple[str, str], dict[str, Any]] = {}
    dist_mismatch = 0
    for key, group_rows in grouped.items():
        inv = rules.aggregate_register_rows(group_rows)
        if inv["dist_total"] is not None and inv["invoice_total"] is not None and abs(inv["dist_total"] - inv["invoice_total"]) > 0.01:
            dist_mismatch += 1
        inv["ns"] = key[0]
        inv["from_register"] = True
        invoices[key] = inv

    # 2. Latest aging snapshot: open balances for register invoices; invoices missing from the register.
    aging = _fetch_all(
        conn,
        f"SELECT {_ns("p->>'company_name'", 'batch_company')} AS ns, p FROM fr_ar_aging WHERE snapshot_date = %s AND {_txt('invoice_number')} IS NOT NULL",
        (latest,),
    ) if latest else []
    from_snapshot = 0
    for r in aging:
        p = r["p"]
        key = (r["ns"], str(p.get("invoice_number")).strip())
        amount_due = rules.parse_number(p.get("amount_due"))
        inv = invoices.get(key)
        if inv is None:
            invoice_amount = rules.parse_number(p.get("invoice_amount"))
            inv = {
                "ns": r["ns"], "from_register": False, "invoice_number": key[1],
                "customer_number": _clean(p.get("customer_number")), "customer_name": _clean(p.get("customer_name")),
                "parent_customer_number": _clean(p.get("parent_customer_number")), "parent_customer_name": _clean(p.get("parent_customer_name")),
                "job_number": _clean(p.get("service_location_job_number")), "invoice_date": rules.parse_export_date(p.get("invoice_date")),
                "posting_date": None, "billing_period_from": rules.parse_export_date(p.get("billing_period_from")),
                "billing_period_to": rules.parse_export_date(p.get("billing_period_to")),
                "purchase_order_number": _clean(p.get("purchase_order_number")), "company_name": _clean(p.get("company_name")),
                "invoice_total": invoice_amount, "revenue_total": invoice_amount, "tax": None, "rows": 0,
            }
            inv["service_month"] = (inv["billing_period_from"] or inv["invoice_date"])
            if inv["service_month"]:
                inv["service_month"] = inv["service_month"].replace(day=1)
            invoices[key] = inv
            from_snapshot += 1
        inv["amount_due"] = amount_due
        inv["days_out"] = rules.parse_number(p.get("days_out"))
        inv["aging_bucket"] = rules.ar_bucket_from_groups(p) or rules.ar_bucket_for_days(int(inv["days_out"]) if inv["days_out"] is not None else None)
        inv["terms"] = _clean(p.get("invoice_term_description"))
        inv["customer_name"] = inv.get("customer_name") or _clean(p.get("customer_name"))
        inv["parent_customer_name"] = inv.get("parent_customer_name") or _clean(p.get("parent_customer_name"))

    # 3. Customers (one row per customer number; shared numbers keep the most frequent name/company).
    customer_votes: dict[str, Counter] = defaultdict(Counter)
    company_votes: dict[str, Counter] = defaultdict(Counter)
    records: list[dict[str, Any]] = []
    basis_counts: Counter = Counter()
    for (ns, number), inv in invoices.items():
        if not inv.get("customer_number"):
            continue
        company = resolve_company(inv.get("company_name"), ns, inv.get("job_number"))
        amount_paid, basis = rules.open_balance_from_snapshot(inv.get("invoice_total"), inv.get("amount_due"))
        basis_counts[basis] += 1
        customer_votes[inv["customer_number"]][inv.get("customer_name") or ""] += 1
        company_votes[inv["customer_number"]][company or ""] += 1
        records.append(
            {
                "winteam_id": f"ar:{ns}:{number}", "customer_number": inv["customer_number"], "invoice_number": number,
                "job_number": inv.get("job_number"), "invoice_date": inv.get("invoice_date"), "posting_date": inv.get("posting_date"),
                "billing_period_from": inv.get("billing_period_from"), "billing_period_to": inv.get("billing_period_to"),
                "service_month": inv.get("service_month"), "terms": inv.get("terms"), "po_number": inv.get("purchase_order_number"),
                "tax": inv.get("tax"), "amount_paid": round(amount_paid, 2) if amount_paid is not None else None,
                "revenue_total": inv.get("revenue_total"), "invoice_total": inv.get("invoice_total"), "company": company,
                "customer_name": inv.get("customer_name"), "parent_customer_number": inv.get("parent_customer_number"),
                "parent_customer_name": inv.get("parent_customer_name"),
                "is_collectible": rules.is_collectible(inv.get("customer_name"), inv.get("parent_customer_name"), treatment_rules),
                "days_outstanding_snapshot": int(inv["days_out"]) if inv.get("days_out") is not None else None,
                "aging_bucket_snapshot": inv.get("aging_bucket"), "open_balance_basis": basis,
            }
        )
    customers = [
        {"customer_number": n, "customer_name": (votes.most_common(1)[0][0] or None), "company": (company_votes[n].most_common(1)[0][0] or None)}
        for n, votes in customer_votes.items()
    ]

    with conn.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO core.dim_customer (customer_number, customer_name, source, company)
            VALUES (%(customer_number)s, %(customer_name)s, 'winteam', %(company)s)
            ON CONFLICT (customer_number) DO UPDATE SET customer_name = coalesce(excluded.customer_name, core.dim_customer.customer_name), company = excluded.company
            """,
            customers,
        )
        cursor.executemany(
            """
            INSERT INTO core.fact_ar_invoice (
              winteam_id, customer_key, customer_number, invoice_number, job_key, job_number, invoice_date, posting_date, billing_period_from,
              billing_period_to, service_month, terms, po_number, tax, amount_paid, revenue_total, invoice_total, source, company,
              customer_name, parent_customer_number, parent_customer_name, is_collectible, days_outstanding_snapshot, aging_bucket_snapshot,
              open_balance_basis
            ) VALUES (
              %(winteam_id)s, (SELECT customer_key FROM core.dim_customer WHERE customer_number = %(customer_number)s), %(customer_number)s,
              %(invoice_number)s, (SELECT job_key FROM core.dim_job WHERE job_number = %(job_number)s AND valid_to IS NULL LIMIT 1), %(job_number)s,
              %(invoice_date)s, %(posting_date)s, %(billing_period_from)s, %(billing_period_to)s, %(service_month)s, %(terms)s, %(po_number)s,
              %(tax)s, %(amount_paid)s, %(revenue_total)s, %(invoice_total)s, 'finance_reference', %(company)s, %(customer_name)s,
              %(parent_customer_number)s, %(parent_customer_name)s, %(is_collectible)s, %(days_outstanding_snapshot)s, %(aging_bucket_snapshot)s,
              %(open_balance_basis)s
            )
            ON CONFLICT (winteam_id) DO NOTHING
            """,
            records,
        )
        cursor.execute(
            """
            UPDATE core.dim_customer c SET parent_account_key = s.parent_account_key, warehouse_updated_at = now()
            FROM (SELECT i.customer_number, mode() WITHIN GROUP (ORDER BY j.parent_account_key) AS parent_account_key
                  FROM core.fact_ar_invoice i JOIN core.dim_job j ON j.job_key = i.job_key
                  WHERE j.parent_account_key IS NOT NULL GROUP BY i.customer_number) s
            WHERE s.customer_number = c.customer_number
            """
        )
        # 4. Every aging snapshot, every row (buckets = the WinTeam groups; group0 is "not yet due"). The
        #    collectible flag applies the treatment rules to the billed customer (rules.is_collectible).
        patterns = [str(r.get("match")) for r in treatment_rules if r.get("match") and not r.get("include_collectible_ar", False)]
        cursor.execute(
            f"""
            INSERT INTO core.fact_ar_aging_snapshot (
              source, snapshot_date, company, customer_number, invoice_number, customer_name, parent_customer_number, parent_customer_name,
              job_number, job_description, invoice_date, billing_period_from, billing_period_to, invoice_amount, amount_due, unapplied_cash,
              pending_payments, days_out, past_due_days, bucket_current, bucket_1_30, bucket_31_60, bucket_61_90, bucket_90_plus, terms, status,
              is_collectible
            )
            SELECT DISTINCT ON (snapshot_date, company, customer_number, invoice_number)
              'finance_reference', snapshot_date, company, customer_number, invoice_number, customer_name, parent_customer_number,
              parent_customer_name, job_number, job_description, invoice_date, billing_period_from, billing_period_to, invoice_amount,
              amount_due, unapplied_cash, pending_payments, days_out, past_due_days, group0, group1, group2, group3, group4, terms, status,
              NOT (coalesce(customer_name, parent_customer_name, '') ~* ANY(%(patterns)s::text[]))
            FROM (
              SELECT snapshot_date, coalesce({_alias("coalesce(p->>'company_name', batch_company)")}, '') AS company,
                     coalesce({_txt('customer_number')}, '') AS customer_number, {_txt('invoice_number')} AS invoice_number,
                     {_txt('customer_name')} AS customer_name, {_txt('parent_customer_number')} AS parent_customer_number,
                     {_txt('parent_customer_name')} AS parent_customer_name, {_txt('service_location_job_number')} AS job_number,
                     {_txt('service_location_job_description')} AS job_description, {_usdate('invoice_date')} AS invoice_date,
                     {_usdate('billing_period_from')} AS billing_period_from, {_usdate('billing_period_to')} AS billing_period_to,
                     {_num('invoice_amount')} AS invoice_amount, {_num('amount_due')} AS amount_due, {_num('unapplied_cash')} AS unapplied_cash,
                     {_num('pending_payments')} AS pending_payments, {_int('days_out')} AS days_out, {_int('past_due_days')} AS past_due_days,
                     {_num('group0')} AS group0, {_num('group1')} AS group1, {_num('group2')} AS group2, {_num('group3')} AS group3,
                     {_num('group4')} AS group4, {_txt('invoice_term_description')} AS terms, {_txt('status')} AS status, id
              FROM fr_ar_aging
            ) x
            WHERE invoice_number IS NOT NULL
            ORDER BY snapshot_date, company, customer_number, invoice_number, id
            """,
            {**params, "patterns": patterns},
        )
        aging_rows = cursor.rowcount
    return {
        "invoices": len(records), "customers": len(customers), "register_rows": len(register), "register_invoices": len(grouped),
        "invoices_from_snapshot_only": from_snapshot, "open_balance_basis": dict(basis_counts),
        "register_distribution_mismatches": dist_mismatch, "aging_snapshot_rows": aging_rows, "latest_ar_snapshot": jsonable(latest),
    }


# ── step: payables ───────────────────────────────────────────────────────────
def load_payables(conn: Any, aliases: dict[str, str]) -> dict[str, Any]:
    """core.dim_vendor, core.fact_ap_aging_snapshot, core.fact_ap_invoice, core.fact_ap_payment."""
    params = {"aliases": Jsonb(aliases), "offset": rules.SARUS_VENDOR_OFFSET}
    latest = _latest_snapshot(conn, "fr_ap_aging")
    with conn.cursor() as cursor:
        # Parsed views over the staged exports (TEMP so they die with the session).
        cursor.execute(
            f"""
            CREATE TEMP TABLE fr_ap_aging_rows AS
            SELECT id, snapshot_date, {_ns("p->>'company_name'", 'batch_company')} AS ns,
                   coalesce({_alias("coalesce(p->>'company_name', batch_company)")}, '') AS company,
                   {_int('company_number')} AS company_number, {_int('vendor_number')} AS vendor_number, {_txt('vendor_name')} AS vendor_name,
                   {_txt('vendor_type')} AS vendor_type, {_txt('invoice_number')} AS invoice_number,
                   coalesce({_txt('invoice_entry_number')}, '') AS invoice_entry_number, {_usdate('invoice_date')} AS invoice_date,
                   {_usdate('standard_due_date')} AS due_date, {_num('invoice_amount')} AS invoice_amount, {_num('amount_paid')} AS amount_paid,
                   {_num('balance')} AS balance, {_int('days_past_due')} AS days_past_due,
                   {_num('group1')} AS group1, {_num('group2')} AS group2, {_num('group3')} AS group3, {_num('group4')} AS group4,
                   {_usdate('max_of_check_date')} AS last_check_date, {_txt('max_of_check_number')} AS last_check_number,
                   {_flag('permanent_hold')} AS permanent_hold, {_txt('status')} AS status
            FROM fr_ap_aging
            """,
            params,
        )
        cursor.execute(
            f"""
            CREATE TEMP TABLE fr_ap_activity_rows AS
            SELECT id, {_ns('batch_company')} AS ns, {_alias('batch_company')} AS company,
                   {_int('vendor_number')} AS vendor_number, {_txt('vendor_name')} AS vendor_name, {_txt('invoice_number')} AS invoice_number,
                   {_usdate('invoice_date')} AS invoice_date, {_usdate('due_date')} AS due_date, {_num('invoice_amount')} AS invoice_amount,
                   {_num('check_amount')} AS check_amount, {_usdate('check_date')} AS check_date, {_txt('check_number')} AS check_number,
                   {_num('balance_due')} AS balance_due, {_txt('payment_status')} AS payment_status, {_txt('deposit_reference')} AS payment_method
            FROM fr_ap_activity
            """,
            params,
        )
        cursor.execute(
            f"""
            CREATE TEMP TABLE fr_ap_cash_rows AS
            SELECT DISTINCT ON (ns, vendor_number, invoice_number) ns, vendor_number, invoice_number, due_date, vendor_type, vendor_name
            FROM (
              SELECT snapshot_date, {_ns("p->>'company_name'", 'batch_company')} AS ns, {_int('vendor_number')} AS vendor_number,
                     {_txt('invoice_number')} AS invoice_number, {_usdate('invoice_due_date')} AS due_date, {_txt('vendor_type')} AS vendor_type,
                     {_txt('vendor_name')} AS vendor_name
              FROM fr_ap_cash
            ) x
            WHERE vendor_number IS NOT NULL AND invoice_number IS NOT NULL
            ORDER BY ns, vendor_number, invoice_number, snapshot_date DESC
            """
        )

        # 1. Vendors: latest name per (namespace, number); Sarus numbers are offset (rules.SARUS_VENDOR_OFFSET).
        cursor.execute(
            """
            INSERT INTO core.dim_vendor (winteam_id, vendor_number, vendor_name, active, source)
            SELECT DISTINCT ON (ns, vendor_number)
                   'fr:' || ns || ':' || vendor_number::text,
                   vendor_number + CASE WHEN ns = 'Sarus' THEN %(offset)s ELSE 0 END,
                   coalesce(vendor_name, 'Vendor ' || vendor_number::text), true, 'finance_reference'
            FROM (
              SELECT ns, vendor_number, vendor_name, snapshot_date, invoice_date, 0 AS prio FROM fr_ap_aging_rows
              UNION ALL SELECT ns, vendor_number, vendor_name, NULL, invoice_date, 1 FROM fr_ap_activity_rows
              UNION ALL SELECT ns, vendor_number, vendor_name, NULL, NULL, 2 FROM fr_ap_cash_rows
            ) v
            WHERE vendor_number IS NOT NULL
            ORDER BY ns, vendor_number, prio, snapshot_date DESC NULLS LAST, invoice_date DESC NULLS LAST
            ON CONFLICT (vendor_number) DO NOTHING
            """,
            params,
        )
        vendors = cursor.rowcount

        # 2. Every AP aging snapshot row (group1 split by days past due; see rules.ap_buckets). vendor_number is
        #    the warehouse number (Sarus offset) so the snapshot joins core.dim_vendor / fact_ap_invoice.
        cursor.execute(
            """
            INSERT INTO core.fact_ap_aging_snapshot (
              source, snapshot_date, company, vendor_number, invoice_number, invoice_entry_number, vendor_name, vendor_type, invoice_date,
              due_date, invoice_amount, amount_paid, balance, days_past_due, bucket_current, bucket_1_30, bucket_31_60, bucket_61_90,
              bucket_90_plus, last_check_date, permanent_hold
            )
            SELECT DISTINCT ON (snapshot_date, company, vendor_number, invoice_number, invoice_entry_number)
              'finance_reference', snapshot_date, company,
              coalesce((vendor_number + CASE WHEN ns = 'Sarus' THEN %(offset)s ELSE 0 END)::text, ''), invoice_number, invoice_entry_number, vendor_name,
              vendor_type, invoice_date, due_date, invoice_amount, amount_paid, balance, days_past_due,
              CASE WHEN coalesce(days_past_due, 0) > 0 THEN 0 ELSE coalesce(group1, 0) END,
              CASE WHEN coalesce(days_past_due, 0) > 0 THEN coalesce(group1, 0) ELSE 0 END,
              coalesce(group2, 0), coalesce(group3, 0), coalesce(group4, 0), last_check_date, permanent_hold
            FROM fr_ap_aging_rows
            WHERE invoice_number IS NOT NULL
            ORDER BY snapshot_date, company, vendor_number, invoice_number, invoice_entry_number, id
            """,
            params,
        )
        aging_rows = cursor.rowcount

        # 3. Open invoices from the latest snapshot (+ cash-requirement due dates), then paid history from vendor activity.
        cursor.execute(
            """
            INSERT INTO core.fact_ap_invoice (
              winteam_id, vendor_key, vendor_number, company_number, invoice_number, invoice_date, due_date, invoice_amount, permanent_hold,
              source, company, vendor_name, vendor_type, amount_paid, open_balance, days_past_due, snapshot_date
            )
            SELECT DISTINCT ON (a.ns, a.vendor_number, a.invoice_number)
              'ap:' || a.ns || ':' || a.vendor_number::text || ':' || a.invoice_number,
              v.vendor_key, v.vendor_number, a.company_number, a.invoice_number, a.invoice_date, coalesce(a.due_date, c.due_date), a.invoice_amount,
              a.permanent_hold, 'finance_reference', a.company, coalesce(a.vendor_name, v.vendor_name), coalesce(a.vendor_type, c.vendor_type),
              a.amount_paid, a.balance, a.days_past_due, a.snapshot_date
            FROM fr_ap_aging_rows a
            JOIN core.dim_vendor v ON v.winteam_id = 'fr:' || a.ns || ':' || a.vendor_number::text
            LEFT JOIN fr_ap_cash_rows c ON c.ns = a.ns AND c.vendor_number = a.vendor_number AND c.invoice_number = a.invoice_number
            WHERE a.snapshot_date = %(latest)s AND a.invoice_number IS NOT NULL AND a.vendor_number IS NOT NULL
            ORDER BY a.ns, a.vendor_number, a.invoice_number, a.invoice_entry_number, a.id
            ON CONFLICT (winteam_id) DO NOTHING
            """,
            {**params, "latest": latest},
        )
        open_invoices = cursor.rowcount
        cursor.execute(
            """
            INSERT INTO core.fact_ap_invoice (
              winteam_id, vendor_key, vendor_number, invoice_number, invoice_date, due_date, invoice_amount, source, company, vendor_name,
              amount_paid, open_balance
            )
            SELECT 'ap:' || x.ns || ':' || x.vendor_number::text || ':' || x.invoice_number,
                   v.vendor_key, v.vendor_number, x.invoice_number, x.invoice_date, x.due_date, x.invoice_amount, 'finance_reference', x.company,
                   coalesce(x.vendor_name, v.vendor_name), x.amount_paid, x.balance_due
            FROM (
              SELECT ns, vendor_number, invoice_number, min(invoice_date) AS invoice_date, min(due_date) AS due_date,
                     sum(invoice_amount) AS invoice_amount, sum(check_amount) AS amount_paid, sum(balance_due) AS balance_due,
                     max(vendor_name) AS vendor_name, max(company) AS company
              FROM fr_ap_activity_rows
              WHERE invoice_number IS NOT NULL AND vendor_number IS NOT NULL
              GROUP BY ns, vendor_number, invoice_number
            ) x
            JOIN core.dim_vendor v ON v.winteam_id = 'fr:' || x.ns || ':' || x.vendor_number::text
            ON CONFLICT (winteam_id) DO NOTHING
            """
        )
        activity_invoices = cursor.rowcount

        # 4. Payments: one per vendor-activity check line; aging-derived payments only where activity has none.
        cursor.execute(
            """
            INSERT INTO core.fact_ap_payment (
              winteam_id, payment_method, check_number, check_date, payment_date, amount, company_name, vendor_key, vendor_number, vendor_name, source
            )
            SELECT 'apactivity:' || x.id::text, x.payment_method, x.check_number, x.check_date, x.check_date, x.check_amount, x.company,
                   v.vendor_key, v.vendor_number, coalesce(x.vendor_name, v.vendor_name), 'finance_reference'
            FROM fr_ap_activity_rows x
            LEFT JOIN core.dim_vendor v ON v.winteam_id = 'fr:' || x.ns || ':' || x.vendor_number::text
            WHERE x.check_date IS NOT NULL AND coalesce(x.check_amount, 0) <> 0
            ON CONFLICT (winteam_id) DO NOTHING
            """
        )
        activity_payments = cursor.rowcount
        cursor.execute(
            """
            INSERT INTO core.fact_ap_payment (
              winteam_id, check_number, check_date, payment_date, amount, company_name, vendor_key, vendor_number, vendor_name, source
            )
            SELECT DISTINCT ON (a.ns, a.vendor_number, a.invoice_number)
                   'apaging:' || a.ns || ':' || a.vendor_number::text || ':' || a.invoice_number, a.last_check_number, a.last_check_date,
                   a.last_check_date, a.amount_paid, a.company, v.vendor_key, v.vendor_number, coalesce(a.vendor_name, v.vendor_name), 'finance_reference'
            FROM fr_ap_aging_rows a
            LEFT JOIN core.dim_vendor v ON v.winteam_id = 'fr:' || a.ns || ':' || a.vendor_number::text
            WHERE a.amount_paid > 0 AND a.last_check_date IS NOT NULL AND a.invoice_number IS NOT NULL AND a.vendor_number IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM fr_ap_activity_rows x
                WHERE x.ns = a.ns AND x.vendor_number = a.vendor_number AND x.invoice_number = a.invoice_number AND x.check_date IS NOT NULL
              )
            ORDER BY a.ns, a.vendor_number, a.invoice_number, a.snapshot_date DESC, a.id
            ON CONFLICT (winteam_id) DO NOTHING
            """
        )
        aging_payments = cursor.rowcount
    return {
        "vendors": vendors, "aging_snapshot_rows": aging_rows, "open_invoices_from_snapshot": open_invoices,
        "invoices_from_activity": activity_invoices, "payments_from_activity": activity_payments, "payments_from_aging": aging_payments,
        "latest_ap_snapshot": jsonable(latest),
        "note": "AP paid by month comes from the vendor activity exports (checks through 2026-05) plus the few aging rows that carry a check date; it is approximate and incomplete after that.",
    }


# ── the load ─────────────────────────────────────────────────────────────────
def load(initiated_by: str = "admin-api") -> dict[str, Any]:
    """POST /integrations/finance-reference/load: full replace of the warehouse from the reference database."""
    if not settings.finance_reference_configured:
        raise RuntimeError("FINANCE_REFERENCE_DATABASE_URL is not configured")
    started = time.monotonic()
    tables: list[dict[str, Any]] = []
    notes: dict[str, Any] = {}
    with connection() as parent_conn:
        parent_run = _start_run(parent_conn, "load")
    try:
        with connection() as conn, reference_connection() as ref:
            with _Step(conn, "reset", tables) as step:
                cleared = reset_warehouse(conn)
                step.inserted = 0
                step.fetched = sum(cleared.values())
                notes["cleared"] = {k: v for k, v in cleared.items() if v}

            config = read_platform_config(ref)
            with _Step(conn, "settings", tables) as step:
                notes["settings"] = load_settings(conn, config)
                step.fetched = step.inserted = 3
            aliases = rules.normalise_aliases(_setting(conn, "company_aliases", {}))
            treatment_rules = [r for r in (_setting(conn, "ar_treatment_rules", []) or []) if isinstance(r, dict)]

            with _Step(conn, "stage", tables) as step:
                counts = stage_reference(conn, ref)
                job_master = read_job_master()
                centroids = read_centroids()
                notes["staged"] = counts
                notes["files"] = {"job_master_rows": len(job_master), "centroids": len(centroids), "data_dir": str(data_dir())}
                step.fetched = step.inserted = sum(counts.values())

            with _Step(conn, "dim_job", tables) as step:
                result = build_jobs(conn, config, aliases, job_master, centroids)
                step.fetched = counts["fr_job"] + counts["fr_job_file"] + len(job_master)
                step.inserted = result["rows"]
                notes["jobs"] = result["stats"]
                notes["job_number_collisions"] = result["collisions"]

            with _Step(conn, "fact_job_cost_month", tables) as step:
                step.fetched = counts["fr_job_cost"]
                step.inserted = load_job_cost(conn)

            with _Step(conn, "fact_labor_budget_month", tables) as step:
                step.fetched = counts["fr_daily_budget"] + counts["fr_hbc"] + counts["fr_wage"]
                result = load_labor_budget(conn, aliases)
                step.inserted = result["daily_budget"] + result["hours_budget_comparison"] + result["wage_by_job"]
                notes["labor_budget"] = result

            with _Step(conn, "fact_daily_budget", tables) as step:
                step.fetched = counts["fr_daily_budget"]
                step.inserted = load_daily_budget(conn, aliases)

            with _Step(conn, "contract_billing", tables) as step:
                result = load_contract_billing(conn, ref)
                step.fetched = result["reference_rows"]
                step.inserted = result["rows"]
                notes["contract_billing"] = result

            with _Step(conn, "fact_timekeeping", tables) as step:
                step.fetched = counts["fr_timekeeping"]
                step.inserted = load_timekeeping(conn, aliases)
                notes["trailing_rate"] = apply_trailing_rates(conn, _close_lag_days(conn))

            with _Step(conn, "fact_ar_invoice", tables) as step:
                step.fetched = counts["fr_ar_register"] + counts["fr_ar_aging"]
                result = load_receivables(conn, aliases, treatment_rules)
                step.inserted = result["invoices"]
                notes["receivables"] = result
            tables.append({"name": "fact_ar_aging_snapshot", "rows": notes["receivables"]["aging_snapshot_rows"]})
            tables.append({"name": "dim_customer", "rows": notes["receivables"]["customers"]})

            with _Step(conn, "fact_ap_invoice", tables) as step:
                step.fetched = counts["fr_ap_aging"] + counts["fr_ap_cash"] + counts["fr_ap_activity"]
                result = load_payables(conn, aliases)
                step.inserted = result["open_invoices_from_snapshot"] + result["invoices_from_activity"]
                notes["payables"] = result
            tables.append({"name": "fact_ap_aging_snapshot", "rows": notes["payables"]["aging_snapshot_rows"]})
            tables.append({"name": "fact_ap_payment", "rows": notes["payables"]["payments_from_activity"] + notes["payables"]["payments_from_aging"]})
            tables.append({"name": "dim_vendor", "rows": notes["payables"]["vendors"]})

        mart_result = marts.rebuild_all(initiated_by=initiated_by)
        with connection() as conn:
            _upsert_setting(conn, "primary_source", SOURCE, "Which source last filled the marts: winteam_api or finance_reference. Set by the loaders; read by the API source block.")
            conn.commit()
    except Exception as exc:
        _finish_run(parent_run, "failed", 0, sum(int(t.get("rows") or 0) for t in tables), str(exc)[:1000])
        raise
    inserted = sum(int(t.get("rows") or 0) for t in tables)
    _finish_run(parent_run, "succeeded", inserted, inserted)
    seconds = round(time.monotonic() - started, 2)
    logger.info("finance_reference load finished in %ss: %s", seconds, tables)
    return {"run_id": parent_run, "tables": tables, "marts": mart_result, "seconds": seconds, "notes": jsonable(notes)}
