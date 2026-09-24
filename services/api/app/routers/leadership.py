"""Leadership labor P&L routes (docs/api-contract.md "Leadership labor P&L").

Reads serve mart.leadership_week joined at read time with the account mapping (ops.account_job), so
a configuration change applies without a rebuild. The browser computes every derived metric
(src/leadership/metrics.ts) from the rows, as the reference dashboard did, so the target input
recalculates instantly. Writes (account configuration, job mapping, file imports) are admin-only.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from .. import accounts, companycam, imports, marts
from ..common import current_user, jsonable, require_admin, source_block
from ..db import connection

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/leadership")

MAX_WEEKS = 26
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
ACCOUNT_SCOPES = ("all", "featured", "other")

ROW_SQL = """
SELECT w.week_start, w.week_end, w.company, w.job_number, w.site_name, w.parent_account,
       aj.account_slug, coalesce(aj.segment, a.fallback_segment) AS segment,
       CASE WHEN aj.account_slug IS NULL THEN 'site' ELSE aj.role END AS role,
       coalesce(aj.needs_review, false) AS needs_review,
       w.hours, w.ot_hours, w.labor, w.labor_basis, w.ot_dollars, w.budget_hours, w.budget_dollars,
       w.employees, w.days_with_labor, w.revenue_month, w.revenue_month_amount AS revenue_month_amount,
       w.revenue_month_basis, w.invoice_week, w.prior_revenue, w.prior_labor, w.prior_labor_basis,
       w.prior_sub, w.prior_sub_basis, w.delivery_model, w.sub_week, w.sub_week_basis,
       w.consumables_cost, w.consumables_basis,
       j.latitude, j.longitude, j.city, j.state_province
FROM mart.leadership_week w
LEFT JOIN ops.account_job aj ON aj.company = w.company AND aj.job_number = w.job_number
LEFT JOIN ops.account a ON a.slug = aj.account_slug
LEFT JOIN core.dim_job j ON j.job_key = w.job_key
WHERE w.week_start BETWEEN %(first)s AND %(last)s
"""


def monday(value: date) -> date:
    return value - timedelta(days=value.weekday())


def parse_week(value: str | None) -> date | None:
    """Accepts a week start (Monday) or the week-ending Sunday the views display; any date maps to its Monday week."""
    if not value:
        return None
    try:
        return monday(date.fromisoformat(value[:10]))
    except ValueError:
        raise HTTPException(status_code=422, detail="week must be an ISO date (YYYY-MM-DD)") from None


def account_rows(cursor: Any) -> list[dict[str, Any]]:
    cursor.execute(
        """
        SELECT a.*, coalesce((SELECT json_agg(json_build_object('name', s.name, 'sort', s.sort, 'target_labor_pct', s.target_labor_pct)
                                             ORDER BY s.sort) FROM ops.account_segment s WHERE s.account_slug = a.slug), '[]') AS segments,
               (SELECT count(*) FROM ops.account_job j WHERE j.account_slug = a.slug) AS sites,
               (SELECT count(*) FROM ops.account_job j WHERE j.account_slug = a.slug AND j.needs_review) AS needs_review
        FROM ops.account a ORDER BY a.sort, a.name
        """
    )
    return [jsonable(dict(r)) for r in cursor.fetchall()]


def week_rows(cursor: Any) -> list[dict[str, Any]]:
    """Every week with rows: labor totals, days with labor and the pay report share, newest last."""
    cursor.execute(
        """
        SELECT week_start, week_end, max(days_with_labor) AS days_with_labor,
               round(sum(labor) FILTER (WHERE labor_basis = 'pay_report') / nullif(sum(labor), 0), 4) AS pay_report_share,
               max(revenue_month) AS revenue_month
        FROM mart.leadership_week GROUP BY week_start, week_end HAVING sum(hours) > 0 ORDER BY week_start
        """
    )
    today = date.today()
    return [{**jsonable(dict(r)), "in_progress": r["week_end"] >= today} for r in cursor.fetchall()]


def default_week(weeks: list[dict[str, Any]]) -> str | None:
    """The latest complete week; the latest week when none is complete."""
    complete = [w for w in weeks if not w["in_progress"]]
    chosen = (complete or weeks)[-1:] if weeks else []
    return chosen[0]["week_start"] if chosen else None


def status_block(cursor: Any) -> dict[str, Any]:
    """Data freshness for the header and notes: last rebuild, last WinTeam sync per integration,
    latest import per feed and the pay report's last covered day per company."""
    cursor.execute(
        """
        SELECT (SELECT max(completed_at) FROM mart.rebuild_log WHERE status = 'succeeded') AS rebuilt_at,
               (SELECT max(rebuilt_at) FROM mart.leadership_week) AS leadership_rebuilt_at
        """
    )
    head = dict(cursor.fetchone())
    cursor.execute(
        """
        SELECT DISTINCT ON (integration_name) integration_name, status, completed_at, started_at
        FROM ops.integration_sync_run ORDER BY integration_name, started_at DESC
        """
    )
    syncs = [jsonable(dict(r)) for r in cursor.fetchall()]
    cursor.execute(
        """
        SELECT DISTINCT ON (kind) kind, file_name, status, period_from, period_to, rows_loaded, loaded_at
        FROM ops.import_file WHERE status = 'loaded' ORDER BY kind, loaded_at DESC
        """
    )
    latest_imports = {r["kind"]: jsonable(dict(r)) for r in cursor.fetchall()}
    cursor.execute("SELECT company, max(date_to) AS through FROM core.pay_report_coverage GROUP BY company ORDER BY company")
    pay_report = [jsonable(dict(r)) for r in cursor.fetchall()]
    return {"rebuilt_at": jsonable(head["rebuilt_at"]), "leadership_rebuilt_at": jsonable(head["leadership_rebuilt_at"]),
            "syncs": syncs, "imports": latest_imports, "pay_report_through": pay_report}


@router.get("/config")
def leadership_config() -> dict[str, Any]:
    """Accounts, segments, available weeks, the default week and data freshness."""
    with connection() as conn, conn.cursor() as cursor:
        weeks = week_rows(cursor)
        payload = {"accounts": account_rows(cursor), "weeks": weeks, "default_week": default_week(weeks), "status": status_block(cursor)}
    return {"source": source_block(), **payload}


@router.get("/rows")
def leadership_rows(
    week: str | None = Query(None, description="Any date in the week; defaults to the latest complete week"),
    weeks: int = Query(1, ge=1, le=MAX_WEEKS, description="Number of weeks ending at `week`"),
    account: str = Query("featured", description="An account slug, or featured | other | all"),
) -> dict[str, Any]:
    """Job-week rows for `weeks` weeks ending at `week`, for one account or a scope."""
    with connection() as conn, conn.cursor() as cursor:
        anchor = parse_week(week)
        if anchor is None:
            anchor_str = default_week(week_rows(cursor))
            if anchor_str is None:
                return {"source": source_block(), "week": None, "weeks": [], "account": account, "rows": []}
            anchor = date.fromisoformat(anchor_str)
        first = anchor - timedelta(weeks=weeks - 1)
        sql = ROW_SQL
        params: dict[str, Any] = {"first": first, "last": anchor}
        if account == "featured":
            sql += " AND a.featured"
        elif account == "other":
            sql += " AND (aj.account_slug IS NULL OR NOT coalesce(a.featured, false))"
        elif account != "all":
            cursor.execute("SELECT 1 FROM ops.account WHERE slug = %s", (account,))
            if cursor.fetchone() is None:
                raise HTTPException(status_code=404, detail=f"Unknown account {account!r}")
            sql += " AND aj.account_slug = %(account)s"
            params["account"] = account
        cursor.execute(sql + " ORDER BY w.week_start, aj.account_slug NULLS LAST, w.job_number", params)
        rows = [jsonable(dict(r)) for r in cursor.fetchall()]
    week_list = [(first + timedelta(weeks=i)).isoformat() for i in range(weeks)]
    return {"source": source_block(), "week": anchor.isoformat(), "weeks": week_list, "account": account, "rows": rows}


@router.get("/sites/{company}/{job_number}")
def leadership_site(company: str, job_number: str, weeks: int = Query(13, ge=1, le=MAX_WEEKS),
                    week: str | None = Query(None), invoice_months: int = Query(6, ge=1, le=24)) -> dict[str, Any]:
    """One site: identity and mapping, weekly rows, subcontractor invoices coded to it, and photos."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT j.job_key, j.company, j.job_number, j.job_name AS site_name, j.address_line_1, j.city, j.state_province,
                   j.postal_code, j.latitude, j.longitude, j.parent_job_number, j.delivery_model, pa.account_name AS parent_account,
                   aj.account_slug, aj.segment, coalesce(aj.role, 'site') AS role, aj.companycam_project_id
            FROM core.dim_job j
            LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
            LEFT JOIN ops.account_job aj ON aj.company = j.company AND aj.job_number = j.job_number
            WHERE j.valid_to IS NULL AND j.company = %s AND j.job_number = %s
            """,
            (company, job_number),
        )
        site = cursor.fetchone()
        if site is None:
            raise HTTPException(status_code=404, detail=f"Unknown job {job_number} ({company})")
        anchor = parse_week(week) or monday(date.today())
        first = anchor - timedelta(weeks=weeks - 1)
        cursor.execute(ROW_SQL + " AND w.job_key = %(job_key)s ORDER BY w.week_start",
                       {"first": first, "last": anchor, "job_key": site["job_key"]})
        rows = [jsonable(dict(r)) for r in cursor.fetchall()]
        invoices = subcontractor_invoices(cursor, site["job_key"], invoice_months)
    photos: dict[str, Any] = {"configured": companycam.configured(), "project_id": site["companycam_project_id"], "items": None, "error": None}
    if photos["configured"] and site["companycam_project_id"]:
        try:
            photos["items"] = companycam.photos_for_project(str(site["companycam_project_id"]))
        except companycam.CompanyCamError as exc:
            photos["error"] = str(exc)
    site_out = jsonable({k: v for k, v in dict(site).items() if k != "job_key"})
    return {"source": source_block(), "site": site_out, "weeks": rows, "invoices": invoices, "photos": photos}


def subcontractor_invoices(cursor: Any, job_key: int, months: int) -> dict[str, Any]:
    """AP GL distribution lines coded to the job from vendors whose type is a subcontractor type
    (setting subcontractor_vendor_type_ids, default [6]), newest first."""
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'subcontractor_vendor_type_ids'")
    row = cursor.fetchone()
    type_ids = [str(v) for v in (row["value"] if row and isinstance(row["value"], list) else [6])]
    since = (date.today().replace(day=1) - timedelta(days=31 * (months - 1))).replace(day=1)
    cursor.execute(
        """
        SELECT d.invoice_number, d.invoice_date, d.gl_account_number, d.amount, v.vendor_number, v.vendor_name,
               v.vendor_type_id
        FROM core.fact_ap_distribution d
        JOIN core.dim_vendor v ON v.vendor_number = d.vendor_number AND v.source = d.source
        WHERE d.job_key = %s AND d.invoice_date >= %s AND v.vendor_type_id::text = ANY (%s)
        ORDER BY d.invoice_date DESC, d.invoice_number
        """,
        (job_key, since, type_ids),
    )
    lines = [jsonable(dict(r)) for r in cursor.fetchall()]
    return {"since": since.isoformat(), "vendor_type_ids": type_ids, "total": round(sum(l["amount"] or 0 for l in lines), 2), "lines": lines}


# ── administration ──────────────────────────────────────────────────────────
class AccountPatch(BaseModel):
    name: str | None = None
    featured: bool | None = None
    sort: int | None = None
    target_labor_pct: float | None = Field(None, gt=0, lt=2)
    watch_band: float | None = Field(None, ge=0, lt=1)
    revenue_method: str | None = None
    revenue_divisor: float | None = Field(None, gt=0)
    budget_reliability_ratio: float | None = Field(None, ge=0, le=2)
    source_parent_accounts: list[str] | None = None
    segment_source: str | None = None
    fallback_segment: str | None = None


class SegmentIn(BaseModel):
    name: str = Field(min_length=1)
    target_labor_pct: float | None = Field(None, gt=0, lt=2)


class JobMappingIn(BaseModel):
    account_slug: str | None = None
    segment: str | None = None
    role: str = "site"
    companycam_project_id: str | None = None


def _actor(request: Request) -> str:
    user = current_user(request)
    return user.username if user is not None else "admin-token"


@router.put("/accounts/{slug}", dependencies=[Depends(require_admin)])
def update_account(slug: str, patch: AccountPatch, request: Request) -> dict[str, Any]:
    changes = patch.model_dump(exclude_none=True)
    if patch.revenue_method is not None and patch.revenue_method not in accounts.REVENUE_METHODS:
        raise HTTPException(status_code=422, detail=f"revenue_method must be one of {accounts.REVENUE_METHODS}")
    if patch.segment_source is not None and patch.segment_source not in accounts.SEGMENT_SOURCES:
        raise HTTPException(status_code=422, detail=f"segment_source must be one of {accounts.SEGMENT_SOURCES}")
    if not changes:
        raise HTTPException(status_code=422, detail="Nothing to change")
    with connection() as conn, conn.cursor() as cursor:
        if patch.fallback_segment is not None:
            cursor.execute("SELECT 1 FROM ops.account_segment WHERE account_slug = %s AND name = %s", (slug, patch.fallback_segment))
            if cursor.fetchone() is None:
                raise HTTPException(status_code=422, detail="fallback_segment must be one of the account's segments")
        assignments = ", ".join(f"{k} = %({k})s" for k in changes)
        cursor.execute(f"UPDATE ops.account SET {assignments}, updated_at = now(), updated_by = %(actor)s WHERE slug = %(slug)s",
                       {**changes, "actor": _actor(request), "slug": slug})
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"Unknown account {slug!r}")
        conn.commit()
        return next(a for a in account_rows(cursor) if a["slug"] == slug)


@router.put("/accounts/{slug}/segments", dependencies=[Depends(require_admin)])
def replace_segments(slug: str, segments: list[SegmentIn]) -> dict[str, Any]:
    """Replace the account's segment list (order = display order). Jobs in a removed segment move to
    the fallback segment, which must stay in the list."""
    names = [s.name for s in segments]
    if len(set(names)) != len(names) or not names:
        raise HTTPException(status_code=422, detail="Segment names must be unique and at least one is required")
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT fallback_segment FROM ops.account WHERE slug = %s", (slug,))
        row = cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Unknown account {slug!r}")
        if row["fallback_segment"] not in names:
            raise HTTPException(status_code=422, detail=f"The fallback segment {row['fallback_segment']!r} must stay in the list")
        cursor.execute("DELETE FROM ops.account_segment WHERE account_slug = %s", (slug,))
        for order, s in enumerate(segments, start=1):
            cursor.execute("INSERT INTO ops.account_segment (account_slug, name, sort, target_labor_pct) VALUES (%s, %s, %s, %s)",
                           (slug, s.name, order, s.target_labor_pct))
        cursor.execute("UPDATE ops.account_job SET segment = %s WHERE account_slug = %s AND role = 'site' AND NOT (segment = ANY (%s))",
                       (row["fallback_segment"], slug, names))
        moved = cursor.rowcount
        conn.commit()
        account = next(a for a in account_rows(cursor) if a["slug"] == slug)
    return {**account, "jobs_moved_to_fallback": moved}


@router.get("/account-jobs", dependencies=[Depends(require_admin)])
def list_account_jobs(account: str | None = Query(None), needs_review: bool | None = Query(None),
                      unmapped: bool = Query(False, description="Current jobs with no mapping (Other)")) -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        if unmapped:
            cursor.execute(
                """
                SELECT j.company, j.job_number, j.job_name, pa.account_name AS parent_account, j.is_active
                FROM core.dim_job j LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
                WHERE j.valid_to IS NULL AND j.job_number IS NOT NULL AND j.company IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM ops.account_job x WHERE x.company = j.company AND x.job_number = j.job_number)
                ORDER BY pa.account_name NULLS LAST, j.job_number
                """
            )
        else:
            cursor.execute(
                """
                SELECT aj.*, j.job_name, pa.account_name AS parent_account, j.is_active
                FROM ops.account_job aj
                LEFT JOIN core.dim_job j ON j.company = aj.company AND j.job_number = aj.job_number AND j.valid_to IS NULL
                LEFT JOIN core.dim_parent_account pa ON pa.parent_account_key = j.parent_account_key
                WHERE (%(account)s::text IS NULL OR aj.account_slug = %(account)s)
                  AND (%(review)s::boolean IS NULL OR aj.needs_review = %(review)s)
                ORDER BY aj.account_slug, aj.job_number
                """,
                {"account": account, "review": needs_review},
            )
        return {"jobs": [jsonable(dict(r)) for r in cursor.fetchall()]}


@router.put("/account-jobs/{company}/{job_number}", dependencies=[Depends(require_admin)])
def map_job(company: str, job_number: str, body: JobMappingIn, request: Request) -> dict[str, Any]:
    """Map a job to an account (segment, role, CompanyCam project), or unmap it (account_slug null -> Other)."""
    if body.role not in accounts.ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {accounts.ROLES}")
    with connection() as conn, conn.cursor() as cursor:
        if body.account_slug is None:
            cursor.execute("DELETE FROM ops.account_job WHERE company = %s AND job_number = %s", (company, job_number))
            conn.commit()
            return {"company": company, "job_number": job_number, "account_slug": None}
        cursor.execute("SELECT fallback_segment, array(SELECT name FROM ops.account_segment s WHERE s.account_slug = a.slug) AS segments "
                       "FROM ops.account a WHERE slug = %s", (body.account_slug,))
        account = cursor.fetchone()
        if account is None:
            raise HTTPException(status_code=404, detail=f"Unknown account {body.account_slug!r}")
        segment = None if body.role != "site" else (body.segment or account["fallback_segment"])
        if segment is not None and segment not in account["segments"]:
            raise HTTPException(status_code=422, detail=f"segment must be one of {account['segments']}")
        cursor.execute(
            """
            INSERT INTO ops.account_job (company, job_number, account_slug, segment, role, companycam_project_id, assigned_by,
                                         needs_review, updated_at, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, 'admin', false, now(), %s)
            ON CONFLICT (company, job_number) DO UPDATE SET account_slug = EXCLUDED.account_slug, segment = EXCLUDED.segment,
              role = EXCLUDED.role, companycam_project_id = EXCLUDED.companycam_project_id, assigned_by = 'admin',
              needs_review = false, updated_at = now(), updated_by = EXCLUDED.updated_by
            RETURNING *
            """,
            (company, job_number, body.account_slug, segment, body.role, body.companycam_project_id, _actor(request)),
        )
        row = jsonable(dict(cursor.fetchone()))
        conn.commit()
    return row


@router.post("/accounts/seed", dependencies=[Depends(require_admin)])
def reload_seed() -> dict[str, Any]:
    """Add accounts, segments and job mappings from config/accounts/seed.json that are missing; nothing is overwritten."""
    try:
        data = accounts.load_seed_file()
    except (OSError, ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=f"Seed file rejected: {exc}") from exc
    with connection() as conn, conn.cursor() as cursor:
        counts = accounts.apply_seed(cursor, data)
        conn.commit()
    return {"added": counts}


@router.get("/imports", dependencies=[Depends(require_admin)])
def list_imports(limit: int = Query(25, ge=1, le=200)) -> dict[str, Any]:
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT * FROM ops.import_file ORDER BY loaded_at DESC LIMIT %s", (limit,))
        files = [jsonable({k: v for k, v in dict(r).items() if k != "sha256"}) for r in cursor.fetchall()]
    return {"files": files}


@router.post("/imports", dependencies=[Depends(require_admin)])
async def upload_import(request: Request, file: UploadFile = File(...), kind: str | None = Form(None),
                        rebuild: bool = Form(True)) -> dict[str, Any]:
    """Load one Pay Report or Job Cost export (CSV/XLSX), then rebuild the marts so the views use it."""
    if kind is not None and kind not in imports.KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {imports.KINDS}")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File is larger than 50 MB")
    with connection() as conn:
        result = imports.load_file(conn, file.filename or "upload.csv", content, kind=kind, origin="upload", uploaded_by=_actor(request))
    marts_result = marts.rebuild_all("leadership-import") if rebuild and result["status"] == "loaded" else None
    return {"file": jsonable({k: v for k, v in result.items() if k != "sha256"}), "marts": jsonable(marts_result)}
