"""An account's net profit from the GL, the CDO's headline: its Trend Income Statement (core.fact_income_statement_month),
else, for a month without one, the Cross Tab Income Statement by job (core.fact_job_income_statement_month) summed over
the account's jobs: revenue less every other line, wages = direct labor, workers' comp = lines labelled workers comp.

Per month with a net profit line:
  net profit (GL)           the statement's net profit line
  workers' comp added       when the statement has no workers' comp line (or zero): - rate x (wages + management wages),
                            rate = setting gl_net_profit.workers_comp_rate (Finance adds 6% of wages)
  adjustments               Finance's adjustments (ops.pl_adjustment) on the account's jobs: an accrual counts in its
                            month and reverses in its reverse_month (a cleared one no longer counts); a reclass counts
                            where it moves an amount into or out of the account. Revenue adds, every cost subtracts.
  adjusted net profit       the sum
A month whose statement has no net profit line is left out.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterable

SETTING = "gl_net_profit"
DEFAULT = {"workers_comp_rate": 0.06}


CROSS_TAB_SQL = """
SELECT s.month, s.category, coalesce(s.label, s.line) ~* 'workers.?\\s*comp' AS workers_comp, sum(s.amount) AS amount
FROM core.fact_job_income_statement_month s
-- Cross Tab companies are company databases (Crane IFS, Sarus), the mapping's are business units: match the job number, Sarus to Sarus.
JOIN ops.account_job aj ON aj.job_number = s.job_number AND ((s.company = 'Sarus') = (aj.company = 'Sarus'))
WHERE aj.account_slug = %(account)s AND s.month >= %(first)s
GROUP BY 1, 2, 3
"""


def cross_tab_statement(rows: Iterable[dict[str, Any]]) -> dict[date, dict[str, float]]:
    """Statement lines per month from Cross Tab rows {month, category, workers_comp, amount}."""
    out: dict[date, dict[str, float]] = {}
    for r in rows:
        m = out.setdefault(r["month"], {"revenue": 0.0, "wages": 0.0, "workers_comp": 0.0, "net_profit": 0.0, "source": "cross_tab"})
        amount = float(r["amount"])
        if r["category"] == "revenue":
            m["revenue"] += amount
            m["net_profit"] += amount
        else:
            m["net_profit"] -= amount
            if r["category"] == "direct_labor":
                m["wages"] += amount
            if r["workers_comp"]:
                m["workers_comp"] += amount
    return out


def rate_of(value: Any) -> float:
    try:
        r = float((value or {}).get("workers_comp_rate", DEFAULT["workers_comp_rate"]))
    except (TypeError, ValueError, AttributeError):
        return DEFAULT["workers_comp_rate"]
    return r if 0 <= r < 1 else DEFAULT["workers_comp_rate"]


def _effect(category: str, amount: float) -> float:
    return amount if category == "revenue" else -amount


def adjustment_effects(adjustments: Iterable[dict[str, Any]], jobs: set[str]) -> dict[date, list[dict[str, Any]]]:
    """Per month, the adjustments that move the account's profit, each with its signed effect."""
    out: dict[date, list[dict[str, Any]]] = {}

    def add(month: date, a: dict[str, Any], effect: float) -> None:
        if effect:
            out.setdefault(month, []).append({"adjustment_id": a.get("adjustment_id"), "kind": a["kind"], "category": a["category"],
                                              "description": a.get("description"), "effect": round(effect, 2)})

    for a in adjustments:
        amount = float(a["amount"])
        to_in = str(a.get("to_job") or "") in jobs
        if a["kind"] == "accrual" and to_in and not a.get("cleared_at"):
            add(a["month"], a, _effect(a["category"], amount))
            if a.get("reverse_month"):
                add(a["reverse_month"], a, -_effect(a["category"], amount))
        elif a["kind"] == "reclass":
            from_in = str(a.get("from_job") or "") in jobs
            if to_in != from_in:
                add(a["month"], a, _effect(a["category"], amount) * (1 if to_in else -1))
    return out


def months(statement: dict[date, dict[str, float]], adjustments: dict[date, list[dict[str, Any]]], rate: float) -> list[dict[str, Any]]:
    out = []
    for month in sorted(statement):
        lines = statement[month]
        if lines.get("net_profit") is None:
            continue
        wages = (lines.get("wages") or 0) + (lines.get("management_wages") or 0)
        wc = -round(rate * wages, 2) if not lines.get("workers_comp") else 0.0
        adj = adjustments.get(month, [])
        adj_total = round(sum(a["effect"] for a in adj), 2)
        net = float(lines["net_profit"])
        out.append({"month": month.isoformat(), "source": lines.get("source") or "trend_income_statement", "revenue": lines.get("revenue"), "net_profit": round(net, 2), "workers_comp_added": wc,
                    "adjustments": adj_total, "adjustment_lines": adj, "adjusted_net_profit": round(net + wc + adj_total, 2)})
    return out
