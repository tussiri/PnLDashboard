"""Leadership labor P&L routes (docs/api-contract.md "Leadership labor P&L").

Reads serve mart.leadership_week joined at read time with the account mapping (ops.account_job), so
a configuration change applies without a rebuild. For accounts with revenue_allocation 'budget_hours'
the revenue on the account's billing catch-all jobs is spread over its sites (`allocate_parent_billing`;
revenue_allocated = the amount moved onto, or off, the row). The browser computes every derived metric
(src/leadership/metrics.ts) from the rows, as the reference dashboard did, so the target input
recalculates instantly. Writes (account configuration, job mapping, file imports) are admin-only.
"""
from __future__ import annotations

import logging
import re
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
       aj.account_slug, CASE WHEN aj.role = 'site' THEN coalesce(aj.segment, a.fallback_segment) END AS segment,
       CASE WHEN aj.account_slug IS NULL THEN 'site' ELSE aj.role END AS role,
       coalesce(aj.needs_review, false) AS needs_review,
       w.hours, w.ot_hours, w.labor, w.labor_basis, w.ot_dollars, w.budget_hours, w.budget_dollars,
       w.employees, w.days_with_labor, w.revenue_month,
       w.revenue_month_amount, 0 AS revenue_allocated, NULL AS allocation_weight,
       w.revenue_month_basis, w.invoice_week, w.prior_revenue, w.prior_labor, w.prior_labor_basis,
       w.prior_sub, w.prior_sub_basis, w.delivery_model, w.sub_week, w.sub_week_basis,
       w.consumables_cost, w.consumables_basis,
       j.latitude, j.longitude, j.city, j.state_province, j.parent_job_number,
       coalesce(jw.dt_hours, 0) AS dt_hours,
       rr.revenue_run_rate, rr.variable_run_rate, vm.revenue_variable AS revenue_month_variable,
       a.revenue_allocation AS _allocation, w.revenue_month_budget_hours AS _rm_budget_hours, w.revenue_month_hours AS _rm_hours
FROM mart.leadership_week w
LEFT JOIN ops.account_job aj ON aj.company = w.company AND aj.job_number = w.job_number
LEFT JOIN ops.account a ON a.slug = aj.account_slug
LEFT JOIN core.dim_job j ON j.job_key = w.job_key
LEFT JOIN mart.job_week jw ON jw.job_key = w.job_key AND jw.week_start = w.week_start
LEFT JOIN core.fact_job_cost_month vm ON vm.source = 'export_import' AND vm.company = w.company AND vm.job_number = w.job_number
                                     AND vm.month = w.revenue_month
-- The 3-month run rate (the FedEx report's invoice basis): the revenue month and the two before it,
-- each month from job cost, else Relay AR where the week's revenue comes from Relay.
LEFT JOIN LATERAL (
  SELECT avg(coalesce(nullif(jc.revenue, 0), CASE WHEN w.revenue_month_basis LIKE 'relay%%' THEN r.ar_revenue END, 0)) AS revenue_run_rate,
         avg(ex.revenue_variable) AS variable_run_rate
  FROM generate_series(w.revenue_month - interval '2 months', w.revenue_month, interval '1 month') AS g(m)
  LEFT JOIN mart.v_job_cost_month_effective jc ON jc.company = w.company AND jc.job_number = w.job_number AND jc.month = g.m::date
  LEFT JOIN mart.v_relay_job_month r ON r.job_number = w.job_number AND r.month = g.m::date
  LEFT JOIN core.fact_job_cost_month ex ON ex.source = 'export_import' AND ex.company = w.company AND ex.job_number = w.job_number
                                       AND ex.month = g.m::date
) rr ON w.revenue_month IS NOT NULL
WHERE w.week_start BETWEEN %(first)s AND %(last)s
"""


def allocate_parent_billing(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Spread parent-billed revenue over an account's sites (accounts with revenue_allocation
    'budget_hours'). Per account and week: when the account's catch-all jobs carry revenue-month
    revenue and none of its sites do, that revenue moves to the sites present that week in proportion
    to their revenue-month budget hours, else their revenue-month actual hours, else this week's hours.
    Totals are preserved: the heaviest-weighted site takes the rounding, so a zero-weight site gets
    exactly nothing (not a stray cent that reads as billing). Internal `_` fields are removed."""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in rows:
        if r.get("_allocation") == "budget_hours" and r.get("account_slug"):
            groups.setdefault((r["account_slug"], r["week_start"]), []).append(r)
    for group in groups.values():
        sources = [r for r in group if r["role"] == "catch_all" and (r["revenue_month_amount"] or 0) > 0]
        sites = [r for r in group if r["role"] == "site"]
        if not sources or not sites or any((r["revenue_month_amount"] or 0) > 0 for r in sites):
            continue
        candidates = (("budget_hours", [r["_rm_budget_hours"] or 0 for r in sites]), ("actual_hours", [r["_rm_hours"] or 0 for r in sites]),
                      ("week_hours", [r["hours"] or 0 for r in sites]))
        basis, weights = next(((b, w) for b, w in candidates if sum(w) > 0), (None, None))
        if weights is None:
            continue
        pool = sum(r["revenue_month_amount"] for r in sources)
        prior_pool = sum(r["prior_revenue"] or 0 for r in sources)
        total = sum(weights)
        shares = [round(pool * w / total, 2) for w in weights]
        prior_shares = [round(prior_pool * w / total, 2) for w in weights]
        heaviest = max(range(len(weights)), key=lambda i: weights[i])
        shares[heaviest] = round(shares[heaviest] + pool - sum(shares), 2)
        prior_shares[heaviest] = round(prior_shares[heaviest] + prior_pool - sum(prior_shares), 2)
        for r, share, prior_share in zip(sites, shares, prior_shares):
            r["revenue_month_amount"] = share
            r["prior_revenue"] = (r["prior_revenue"] or 0) + prior_share
            r["revenue_allocated"] = share
            r["allocation_weight"] = basis
        for r in sources:
            r["revenue_allocated"] = -r["revenue_month_amount"]
            r["allocation_weight"] = basis
            r["prior_revenue"] = 0
            r["revenue_month_amount"] = 0
    for r in rows:
        for key in ("_allocation", "_rm_budget_hours", "_rm_hours"):
            r.pop(key, None)
    return rows


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
    """Data freshness for the header and notes: last rebuild, sync health per integration (failed when
    any resource's latest run failed; a resource the tenant is not entitled to, HTTP 403, is ignored),
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
        WITH latest AS (
            SELECT DISTINCT ON (integration_name, resource_name) integration_name, status, error_message, completed_at, started_at
            FROM ops.integration_sync_run ORDER BY integration_name, resource_name, started_at DESC
        )
        SELECT integration_name,
               CASE WHEN bool_or(status = 'failed' AND position('not_entitled' in coalesce(error_message, '')) <> 1) THEN 'failed'
                    WHEN bool_or(status = 'running') THEN 'running' ELSE 'succeeded' END AS status,
               max(completed_at) AS completed_at, max(started_at) AS started_at
        FROM latest GROUP BY integration_name ORDER BY integration_name
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
        rows = allocate_parent_billing([jsonable(dict(r)) for r in cursor.fetchall()])
    week_list = [(first + timedelta(weeks=i)).isoformat() for i in range(weeks)]
    return {"source": source_block(), "week": anchor.isoformat(), "weeks": week_list, "account": account, "rows": rows}


MONTHLY_SQL = """
WITH jobs AS (
  SELECT aj.company, aj.job_number, aj.role, j.job_name, j.parent_job_number
  FROM ops.account_job aj
  LEFT JOIN core.dim_job j ON j.company = aj.company AND j.job_number = aj.job_number AND j.valid_to IS NULL
  WHERE aj.account_slug = %(account)s
),
delivery AS (
  SELECT DISTINCT ON (w.company, w.job_number) w.company, w.job_number, w.delivery_model
  FROM mart.leadership_week w JOIN jobs USING (company, job_number)
  ORDER BY w.company, w.job_number, w.week_start DESC
),
months AS (SELECT g.m::date AS month FROM generate_series(%(first)s::date, %(last)s::date, interval '1 month') AS g(m))
SELECT jobs.company, jobs.job_number, jobs.job_name, jobs.role, jobs.parent_job_number, d.delivery_model, months.month,
       coalesce(jc.revenue, 0) AS revenue, ex.revenue_variable, coalesce(jc.direct_labor, 0) AS direct_labor,
       coalesce(jc.payroll_taxes_insurance, 0) AS payroll_taxes, coalesce(jc.subcontractors, 0) AS subcontractors,
       coalesce(r.ar_revenue, 0) AS relay_ar, coalesce(r.ap_amount, 0) AS relay_ap
FROM jobs CROSS JOIN months
LEFT JOIN delivery d USING (company, job_number)
LEFT JOIN mart.v_job_cost_month_effective jc ON jc.company = jobs.company AND jc.job_number = jobs.job_number AND jc.month = months.month
LEFT JOIN core.fact_job_cost_month ex ON ex.source = 'export_import' AND ex.company = jobs.company AND ex.job_number = jobs.job_number
                                     AND ex.month = months.month
LEFT JOIN mart.v_relay_job_month r ON r.job_number = jobs.job_number AND r.month = months.month
ORDER BY jobs.company, jobs.job_number, months.month
"""


@router.get("/monthly")
def leadership_monthly(account: str = Query(..., description="An account slug"), months: int = Query(3, ge=1, le=12),
                       through: str | None = Query(None, description="Last month (YYYY-MM); defaults to the latest month with revenue")) -> dict[str, Any]:
    """Closed months per job of one account: job cost (revenue, variable revenue, direct labor, payroll taxes,
    subcontractors) and Relay AR / AP, plus the account's income statement lines. Feeds the prior-month
    columns, the Pallet, Income Statement and Subcontracted Sites views."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT 1 FROM ops.account WHERE slug = %s", (account,))
        if cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Unknown account {account!r}")
        if through:
            try:
                last = date.fromisoformat(f"{through[:7]}-01")
            except ValueError:
                raise HTTPException(status_code=422, detail="through must be YYYY-MM") from None
        else:
            cursor.execute(
                """
                SELECT greatest(
                  (SELECT max(jc.month) FROM mart.v_job_cost_month_effective jc JOIN ops.account_job aj
                     ON aj.company = jc.company AND aj.job_number = jc.job_number WHERE aj.account_slug = %(a)s AND jc.revenue > 0),
                  (SELECT max(r.month) FROM mart.v_relay_job_month r JOIN ops.account_job aj ON aj.job_number = r.job_number
                     WHERE aj.account_slug = %(a)s AND r.ar_revenue > 0)) AS last
                """,
                {"a": account},
            )
            last = cursor.fetchone()["last"]
            if last is None:
                return {"account": account, "months": [], "jobs": [], "income_statement": {}}
        first = date(last.year + (last.month - months) // 12, (last.month - months) % 12 + 1, 1)
        cursor.execute(MONTHLY_SQL, {"account": account, "first": first, "last": last})
        jobs: dict[tuple[str, str], dict[str, Any]] = {}
        for r in cursor.fetchall():
            key = (r["company"], r["job_number"])
            job = jobs.setdefault(key, {k: r[k] for k in ("company", "job_number", "job_name", "role", "parent_job_number", "delivery_model")} | {"months": {}})
            job["months"][r["month"].isoformat()] = jsonable({k: r[k] for k in ("revenue", "revenue_variable", "direct_labor", "payroll_taxes",
                                                                                   "subcontractors", "relay_ar", "relay_ap")})
        cursor.execute("SELECT month, line, amount FROM core.fact_income_statement_month WHERE account_slug = %s AND month BETWEEN %s AND %s",
                       (account, first, last))
        statement: dict[str, dict[str, float]] = {}
        for r in cursor.fetchall():
            statement.setdefault(r["month"].isoformat(), {})[r["line"]] = float(r["amount"])
    month_list = [date(first.year + (first.month - 1 + i) // 12, (first.month - 1 + i) % 12 + 1, 1).isoformat() for i in range(months)]
    return {"account": account, "months": month_list, "jobs": list(jobs.values()), "income_statement": statement}


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
        # A parent-billed account's split needs the whole account's rows; others need only the job's.
        if site["account_slug"]:
            cursor.execute(ROW_SQL + " AND aj.account_slug = %(account)s ORDER BY w.week_start",
                           {"first": first, "last": anchor, "account": site["account_slug"]})
        else:
            cursor.execute(ROW_SQL + " AND w.job_key = %(job_key)s ORDER BY w.week_start",
                           {"first": first, "last": anchor, "job_key": site["job_key"]})
        rows = [r for r in allocate_parent_billing([jsonable(dict(r)) for r in cursor.fetchall()])
                if r["company"] == company and r["job_number"] == job_number]
        invoices = subcontractor_invoices(cursor, site["job_key"], invoice_months)
    photos: dict[str, Any] = {"configured": companycam.configured(), "project_id": site["companycam_project_id"], "items": None, "error": None}
    if photos["configured"] and site["companycam_project_id"]:
        try:
            photos["items"] = companycam.photos_for_project(str(site["companycam_project_id"]))
        except companycam.CompanyCamError as exc:
            photos["error"] = str(exc)
    site_out = jsonable({k: v for k, v in dict(site).items() if k != "job_key"})
    return {"source": source_block(), "site": site_out, "weeks": rows, "invoices": invoices, "photos": photos}


def subcontractor_type_ids(cursor: Any) -> list[str]:
    """Vendor type ids that count as subcontractors (setting subcontractor_vendor_type_ids, default [6])."""
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'subcontractor_vendor_type_ids'")
    row = cursor.fetchone()
    return [str(v) for v in (row["value"] if row and isinstance(row["value"], list) else [6])]


def months_back(months: int) -> date:
    """First day of the month `months - 1` months before this one."""
    first = date.today().replace(day=1)
    for _ in range(months - 1):
        first = (first - timedelta(days=1)).replace(day=1)
    return first


RELAY_LINES_SQL = """
SELECT p.vendor_invoice_number AS invoice_number, coalesce(p.recorded_at::date, p.service_month) AS invoice_date,
       NULL::text AS gl_account_number, p.amount, p.vendor_number, p.vendor_name, NULL::int AS vendor_type_id,
       j.company, j.job_number, j.job_name AS site_name, p.service_month, p.status, p.in_winteam, p.payment_status
FROM core.relay_ap_payable p
JOIN core.dim_job j ON j.job_number = p.winteam_job_number AND j.valid_to IS NULL AND j.company IS DISTINCT FROM 'Sarus'
{join}
WHERE NOT p.self_perform AND coalesce(p.service_month, p.recorded_at::date) >= %(since)s AND {where}
ORDER BY coalesce(p.recorded_at::date, p.service_month) DESC, p.vendor_invoice_number
"""


SAME_PAYABLE_DAYS = 45


def _norm_invoice(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def merge_relay_lines(winteam: list[dict[str, Any]], relay_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """WinTeam's posted AP lines plus Relay's payables (FedEx), each marked with its source. A Relay
    payable is left out when it is already among the WinTeam lines: the same vendor and invoice
    number (punctuation ignored), or, when Relay says it is in WinTeam, the same job, vendor and
    amount within SAME_PAYABLE_DAYS (WinTeam can file it under another number; a fixed monthly
    amount recurs, hence the date window rather than amount alone)."""
    def vendor(l: dict[str, Any]) -> str:
        return str(l.get("vendor_number") or "")

    def day(l: dict[str, Any]) -> date | None:
        try:
            return date.fromisoformat(str(l.get("invoice_date"))[:10])
        except ValueError:
            return None

    posted = {(vendor(l), _norm_invoice(l.get("invoice_number"))) for l in winteam}

    def already_posted(r: dict[str, Any]) -> bool:
        if (vendor(r), _norm_invoice(r.get("invoice_number"))) in posted:
            return True
        if not r.get("in_winteam") or day(r) is None:
            return False
        return any(vendor(w) == vendor(r) and w.get("job_number", r.get("job_number")) == r.get("job_number")
                   and abs((w.get("amount") or 0) - (r.get("amount") or 0)) < 0.01
                   and day(w) is not None and abs((day(w) - day(r)).days) <= SAME_PAYABLE_DAYS
                   for w in winteam)

    out = [{**l, "source": "winteam"} for l in winteam]
    out += [{**l, "source": "relay"} for l in relay_lines if not already_posted(l)]
    return sorted(out, key=lambda l: (str(l.get("invoice_date") or ""), str(l.get("invoice_number") or "")), reverse=True)


def subcontractor_invoices(cursor: Any, job_key: int, months: int) -> dict[str, Any]:
    """AP GL distribution lines coded to the job from subcontractor vendors, newest first."""
    type_ids = subcontractor_type_ids(cursor)
    since = months_back(months)
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
    winteam = [jsonable(dict(r)) for r in cursor.fetchall()]
    cursor.execute(RELAY_LINES_SQL.format(join="", where="j.job_key = %(job_key)s"), {"since": since, "job_key": job_key})
    lines = merge_relay_lines(winteam, [jsonable(dict(r)) for r in cursor.fetchall()])
    return {"since": since.isoformat(), "vendor_type_ids": type_ids, "total": round(sum(l["amount"] or 0 for l in lines), 2), "lines": lines}


@router.get("/vendors")
def leadership_vendors(account: str = Query(..., description="An account slug"), months: int = Query(6, ge=1, le=24)) -> dict[str, Any]:
    """Subcontractor invoice lines coded to the account's sites: WinTeam AP GL distributions from
    subcontractor vendors plus, for FedEx, Relay's payables not yet among them (`source`), with totals
    by vendor, by site and by month."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT 1 FROM ops.account WHERE slug = %s", (account,))
        if cursor.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Unknown account {account!r}")
        type_ids = subcontractor_type_ids(cursor)
        since = months_back(months)
        cursor.execute(
            """
            SELECT d.invoice_number, d.invoice_date, d.gl_account_number, d.amount, v.vendor_number, v.vendor_name, v.vendor_type_id,
                   j.company, j.job_number, j.job_name AS site_name
            FROM core.fact_ap_distribution d
            JOIN core.dim_vendor v ON v.vendor_number = d.vendor_number AND v.source = d.source
            JOIN core.dim_job j ON j.job_key = d.job_key AND j.valid_to IS NULL
            JOIN ops.account_job aj ON aj.company = j.company AND aj.job_number = j.job_number
            WHERE aj.account_slug = %s AND d.invoice_date >= %s AND v.vendor_type_id::text = ANY (%s)
            ORDER BY d.invoice_date DESC, d.invoice_number
            """,
            (account, since, type_ids),
        )
        winteam = [jsonable(dict(r)) for r in cursor.fetchall()]
        cursor.execute(RELAY_LINES_SQL.format(join="JOIN ops.account_job aj ON aj.company = j.company AND aj.job_number = j.job_number",
                                              where="aj.account_slug = %(account)s"), {"since": since, "account": account})
        lines = merge_relay_lines(winteam, [jsonable(dict(r)) for r in cursor.fetchall()])

    def group(key: Any, name: Any) -> list[dict[str, Any]]:
        out: dict[Any, dict[str, Any]] = {}
        for line in lines:
            k = key(line)
            g = out.setdefault(k, {**name(line), "amount": 0.0, "invoices": set()})
            g["amount"] += line["amount"] or 0
            g["invoices"].add(line["invoice_number"])
        return sorted(({**g, "amount": round(g["amount"], 2), "invoices": len(g["invoices"])} for g in out.values()), key=lambda g: -g["amount"])

    return {
        "account": account, "since": since.isoformat(), "vendor_type_ids": type_ids,
        "total": round(sum(l["amount"] or 0 for l in lines), 2),
        "by_vendor": group(lambda l: l["vendor_number"], lambda l: {"vendor_number": l["vendor_number"], "vendor_name": l["vendor_name"]}),
        "by_site": group(lambda l: (l["company"], l["job_number"]), lambda l: {"company": l["company"], "job_number": l["job_number"], "site_name": l["site_name"]}),
        "by_month": sorted(group(lambda l: l["invoice_date"][:7], lambda l: {"month": f"{l['invoice_date'][:7]}-01"}), key=lambda g: g["month"]),
        "lines": lines,
    }


# ── administration ──────────────────────────────────────────────────────────
class AccountPatch(BaseModel):
    name: str | None = None
    featured: bool | None = None
    sort: int | None = None
    target_labor_pct: float | None = Field(None, gt=0, lt=2)
    watch_band: float | None = Field(None, ge=0, lt=1)
    revenue_method: str | None = None
    revenue_divisor: float | None = Field(None, gt=0)
    revenue_allocation: str | None = None
    cost_basis: str | None = None
    budget_reliability_ratio: float | None = Field(None, ge=0, le=2)
    source_parent_accounts: list[str] | None = None
    segment_source: str | None = None
    fallback_segment: str | None = None
    segment_label: str | None = Field(None, min_length=1, max_length=30)
    vocabulary: str | None = None
    vendor_factor: float | None = Field(None, ge=0, le=1)
    invoice_basis: str | None = None
    group_by: str | None = None
    split_subcontracted: bool | None = None
    vendor_label: str | None = Field(None, min_length=1, max_length=30)


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
    if patch.revenue_allocation is not None and patch.revenue_allocation not in accounts.REVENUE_ALLOCATIONS:
        raise HTTPException(status_code=422, detail=f"revenue_allocation must be one of {accounts.REVENUE_ALLOCATIONS}")
    if patch.cost_basis is not None and patch.cost_basis not in accounts.COST_BASES:
        raise HTTPException(status_code=422, detail=f"cost_basis must be one of {accounts.COST_BASES}")
    for key, allowed in (("vocabulary", accounts.VOCABULARIES), ("invoice_basis", accounts.INVOICE_BASES), ("group_by", accounts.GROUP_BYS)):
        if getattr(patch, key) is not None and getattr(patch, key) not in allowed:
            raise HTTPException(status_code=422, detail=f"{key} must be one of {allowed}")
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
