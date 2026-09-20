"""Source-to-published reconciliation for the WinTeam AR chain.

Every figure on a reporting page should be traceable to a payload WinTeam returned. This module
proves it continuously instead of by hand, over three layers:

    raw.winteam_record  ->  core.fact_ar_invoice  ->  mart.job_month

`raw -> core` must agree to the cent: normalization copies, it does not judge. A variance there is
an ingestion defect.

`core -> mart` is allowed to differ, because the mart arbitrates between the WinTeam API and the
job-cost export and publishes whichever the revenue basis selects. Two failures are reported:

* **suppressed AR** - invoiced AR published as zero revenue. Never correct. On 2026-09-20 the mart
  published $0 for 334 job-months carrying $9.7M of AR WinTeam had already invoiced, because the
  export shipped half-posted months as rows with revenue 0 and real labor.
* **uncosted revenue** - the mirror. Revenue published with no labor basis at all, so the site
  shows no cost and the portfolio margin reads better than the business performed. Fixing the
  first exposed the second: August 2026 published $3.23M across 243 job-months with zero cost.

Neither is repaired by re-suppressing the other. A month is only reportable when both sides are
covered, and this says which side is short.
"""
from __future__ import annotations

from typing import Any

from .db import connection

# Raw payloads are versioned by hash, so a record can appear several times; only the newest counts.
LATEST_RAW = """
    SELECT DISTINCT ON (source_record_id)
           source_record_id,
           (payload->>'revenueTotal')::numeric AS revenue,
           (payload->>'invoiceDate')::date     AS invoice_date
    FROM raw.winteam_record
    WHERE resource_name = 'ar_invoices' AND payload->>'invoiceDate' IS NOT NULL
    ORDER BY source_record_id, ingested_at DESC
"""


def ar_chain(months: int = 6) -> dict[str, Any]:
    """Per-month raw/core agreement plus any AR the mart publishes as zero revenue."""
    with connection() as conn, conn.cursor() as cursor:
        cursor.execute(
            f"""
            WITH latest_raw AS ({LATEST_RAW}),
            r AS (
              SELECT date_trunc('month', invoice_date)::date AS month,
                     count(*) AS invoices, round(sum(revenue), 2) AS revenue
              FROM latest_raw
              WHERE invoice_date >= (date_trunc('month', current_date) - make_interval(months => %(months)s))::date
              GROUP BY 1
            ),
            c AS (
              SELECT date_trunc('month', invoice_date)::date AS month,
                     count(*) AS invoices, round(sum(revenue_total), 2) AS revenue
              FROM core.fact_ar_invoice
              WHERE source = 'winteam_api'
                AND invoice_date >= (date_trunc('month', current_date) - make_interval(months => %(months)s))::date
              GROUP BY 1
            )
            SELECT coalesce(r.month, c.month) AS month,
                   coalesce(r.invoices, 0) AS raw_invoices, coalesce(c.invoices, 0) AS core_invoices,
                   coalesce(r.revenue, 0)  AS raw_revenue,  coalesce(c.revenue, 0)  AS core_revenue,
                   coalesce(c.revenue, 0) - coalesce(r.revenue, 0) AS variance
            FROM r FULL OUTER JOIN c ON c.month = r.month
            ORDER BY 1
            """,
            {"months": months},
        )
        rows = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT month,
                   count(*) AS job_months,
                   round(sum(invoiced_total), 2) AS ar_published_as_zero
            FROM mart.job_month
            WHERE revenue = 0 AND invoiced_total > 0
              AND month >= (date_trunc('month', current_date) - make_interval(months => %(months)s))::date
            GROUP BY 1 ORDER BY 1
            """,
            {"months": months},
        )
        suppressed = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT month,
                   count(*) AS job_months,
                   round(sum(revenue), 2) AS revenue_without_cost
            FROM mart.job_month
            WHERE revenue > 0 AND labor_basis IS NULL AND coalesce(labor_cost, 0) = 0
              AND month >= (date_trunc('month', current_date) - make_interval(months => %(months)s))::date
            GROUP BY 1 ORDER BY 1
            """,
            {"months": months},
        )
        uncosted = [dict(row) for row in cursor.fetchall()]

    return build_report(rows, suppressed, uncosted)


def build_report(rows: list[dict[str, Any]], suppressed: list[dict[str, Any]],
                 uncosted: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Shape the queries into a verdict. Split out so it can be tested without a database."""
    ingestion_ok = all(_f(row.get("variance")) == 0 and row.get("raw_invoices") == row.get("core_invoices")
                       for row in rows)
    total_suppressed = round(sum(_f(row.get("ar_published_as_zero")) for row in suppressed), 2)
    uncosted = uncosted or []
    total_uncosted = round(sum(_f(row.get("revenue_without_cost")) for row in uncosted), 2)
    return {
        "ar_chain": [_month_row(row) for row in rows],
        "ingestion_exact": ingestion_ok,
        "suppressed_ar": [
            {"month": _iso(row.get("month")), "job_months": int(row.get("job_months") or 0),
             "ar_published_as_zero": round(_f(row.get("ar_published_as_zero")), 2)}
            for row in suppressed
        ],
        "suppressed_ar_total": total_suppressed,
        "uncosted_revenue": [
            {"month": _iso(row.get("month")), "job_months": int(row.get("job_months") or 0),
             "revenue_without_cost": round(_f(row.get("revenue_without_cost")), 2)}
            for row in uncosted
        ],
        "uncosted_revenue_total": total_uncosted,
        "healthy": ingestion_ok and total_suppressed == 0 and total_uncosted == 0,
        "note": (
            "raw -> core must reconcile exactly; a variance is an ingestion defect. "
            "suppressed_ar is invoiced AR published as zero revenue (margin too low); "
            "uncosted_revenue is revenue published with no labor basis (margin too high). "
            "A month is reportable only when both are zero."
        ),
    }


def _f(value: Any) -> float:
    return float(value) if value is not None else 0.0


def _iso(value: Any) -> str | None:
    return value.isoformat() if hasattr(value, "isoformat") else (str(value) if value is not None else None)


def _month_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "month": _iso(row.get("month")),
        "raw_invoices": int(row.get("raw_invoices") or 0),
        "core_invoices": int(row.get("core_invoices") or 0),
        "raw_revenue": round(_f(row.get("raw_revenue")), 2),
        "core_revenue": round(_f(row.get("core_revenue")), 2),
        "variance": round(_f(row.get("variance")), 2),
        "exact": _f(row.get("variance")) == 0 and row.get("raw_invoices") == row.get("core_invoices"),
    }
