"""AR revenue that the job-cost export leaves out (migration 068).

From July 2026 the Crane Job Cost Analysis export (WinTeam FormatID 3) omits revenue GL accounts 31808
(janitorial, subcontracted) and 34001 (OS project revenue). mart.job_month takes a job's revenue from job cost
whenever the job has any there, so a FedEx station whose fixed fee is on 31800 and whose OS billing is on 34001,
or an Amazon site billed partly on 31808, read short of what was invoiced.

After mart.job_month is built, for job-cost rows in the months of setting job_cost_revenue_gap
({"from": "2026-07-01", "until": null}):

  gap(parent account, month)   = max(sum AR - sum revenue over every job of the parent account, 0)
  short(job)                    = max(AR - revenue, 0) for its job-cost row
  added(job)                    = short x min(1, gap / sum short)

Reconciling per parent account keeps AR billed to a parent job that job cost spreads over other jobs (Plano ISD
800, Crowley ISD 910) from being counted twice: there the account's job cost already equals its AR. The amount
is added to revenue and gross_profit, recorded in revenue_ar_gap, and gross_margin_pct is recomputed.
revenue_basis stays 'job_cost', which other views read as "the month is closed".
"""
from __future__ import annotations

from datetime import date
from typing import Any

SETTING = "job_cost_revenue_gap"
DEFAULT = {"from": "2026-07-01", "until": None}

SQL = """
WITH ar AS (
  SELECT job_key, service_month AS month, sum(revenue_total) AS ar
  FROM mart.v_ar_invoice_effective
  WHERE service_month >= %(from)s AND (%(until)s::date IS NULL OR service_month < %(until)s::date)
  GROUP BY 1, 2
),
x AS (
  SELECT m.job_key, m.month, coalesce(j.parent_account_key, -1) AS grp, m.revenue, coalesce(ar.ar, 0) AS ar,
         m.revenue_basis
  FROM mart.job_month m
  JOIN core.dim_job j ON j.job_key = m.job_key
  LEFT JOIN ar ON ar.job_key = m.job_key AND ar.month = m.month
  WHERE m.month >= %(from)s AND (%(until)s::date IS NULL OR m.month < %(until)s::date)
),
g AS (
  SELECT month, grp, greatest(sum(ar) - sum(revenue), 0) AS gap,
         sum(greatest(ar - revenue, 0)) FILTER (WHERE revenue_basis = 'job_cost') AS short
  FROM x GROUP BY 1, 2
),
added AS (
  SELECT x.job_key, x.month, round((x.ar - x.revenue) * least(1, g.gap / g.short), 2) AS amount
  FROM x JOIN g ON g.month = x.month AND g.grp = x.grp
  WHERE x.revenue_basis = 'job_cost' AND x.ar > x.revenue AND g.gap > 0 AND g.short > 0
)
UPDATE mart.job_month m
SET revenue = m.revenue + a.amount,
    gross_profit = m.gross_profit + a.amount,
    revenue_ar_gap = a.amount,
    gross_margin_pct = CASE WHEN m.revenue + a.amount <> 0 AND abs(m.gross_profit + a.amount) < abs(m.revenue + a.amount) * 99999
                            THEN round((m.gross_profit + a.amount) / (m.revenue + a.amount), 4) END
FROM added a
WHERE m.job_key = a.job_key AND m.month = a.month AND a.amount > 0
RETURNING m.month, a.amount
"""


def config(value: Any) -> tuple[date | None, date | None]:
    """(from, until) months; from None = off. Malformed values fall back to the defaults."""
    value = value if isinstance(value, dict) else DEFAULT

    def month(v: Any) -> date | None:
        if v in (None, ""):
            return None
        try:
            return date.fromisoformat(str(v)[:7] + "-01")
        except ValueError:
            return None

    start = month(value.get("from")) if "from" in value else month(DEFAULT["from"])
    return start, month(value.get("until"))


def apply(cursor: Any) -> dict[str, float]:
    """Add the AR shortfall to mart.job_month; returns {YYYY-MM: amount added}."""
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = %s", (SETTING,))
    row = cursor.fetchone()
    start, until = config(row["value"] if row else DEFAULT)
    if start is None:
        return {}
    cursor.execute(SQL, {"from": start, "until": until})
    out: dict[str, float] = {}
    for r in cursor.fetchall():
        key = r["month"].strftime("%Y-%m")
        out[key] = round(out.get(key, 0.0) + float(r["amount"]), 2)
    return out
