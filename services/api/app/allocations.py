"""Corporate allocations (migration 040): what each job-week carries beyond its own labor and vendor cost.

Three kinds, each switched in ops.app_setting 'allocations' and each from a WinTeam report:

* management wages: Job Cost Analysis GL 40200-40399 on the job, for the week's revenue month, ÷ the
  weekly divisor. Assumes salaried management does not punch timekeeping (else turn it off).
* payroll burden: the week's labor × (payroll taxes + workers comp) ÷ wages of the company Trend Income
  Statement for the revenue month, or a manual monthly rate. A month not loaded uses the latest one before it.
* overhead: the company G&A lines of the Trend Income Statement (or a manual monthly amount) ÷ the
  weekly divisor, spread over jobs by their share of the week's company revenue (the monthly revenue
  behind each job's weekly invoice), labor or hours. Shares are of the same week's company totals, so
  a week's overhead adds up to the weekly pool.

Allocations never enter labor %; the views show them as a line and a margin after allocations.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

DIVISOR = 4.33
BASES = ("revenue", "labor", "hours")
DEFAULT_SETTINGS: dict[str, Any] = {
    "management_wages": {"enabled": True},
    "burden": {"enabled": True, "lines": ["payroll_taxes", "workers_comp"]},
    "overhead": {"enabled": True, "lines": ["admin"], "basis": "revenue"},
}


def settings_of(cursor: Any) -> dict[str, Any]:
    cursor.execute("SELECT value FROM ops.app_setting WHERE key = 'allocations'")
    row = cursor.fetchone()
    value = row["value"] if row and isinstance(row["value"], dict) else {}
    return {k: {**v, **(value.get(k) or {})} for k, v in DEFAULT_SETTINGS.items()}


def validate_settings(value: dict[str, Any]) -> dict[str, Any]:
    out = {k: {**v, **(value.get(k) or {})} for k, v in DEFAULT_SETTINGS.items()}
    for kind in out:
        out[kind]["enabled"] = bool(out[kind].get("enabled"))
    for kind in ("burden", "overhead"):
        lines = out[kind].get("lines")
        if not isinstance(lines, list) or not all(isinstance(x, str) and x for x in lines):
            raise ValueError(f"{kind}.lines must be a list of income statement line names")
    if out["overhead"].get("basis") not in BASES:
        raise ValueError(f"overhead.basis must be one of {', '.join(BASES)}")
    return out


def _f(value: Any) -> float | None:
    return None if value is None else float(value)


def statement(cursor: Any) -> dict[date, dict[str, float]]:
    cursor.execute("SELECT month, line, amount FROM core.fact_company_income_statement_month ORDER BY month")
    out: dict[date, dict[str, float]] = {}
    for r in cursor.fetchall():
        out.setdefault(r["month"], {})[r["line"]] = float(r["amount"])
    return out


def manual(cursor: Any) -> dict[date, dict[str, float | None]]:
    cursor.execute("SELECT month, burden_rate, overhead_pool FROM ops.allocation_month")
    return {r["month"]: {"burden_rate": _f(r["burden_rate"]), "overhead_pool": _f(r["overhead_pool"])} for r in cursor.fetchall()}


def month_figures(month: date, cfg: dict[str, Any], lines_by_month: dict[date, dict[str, float]],
                  overrides: dict[date, dict[str, float | None]]) -> dict[str, Any]:
    """Burden rate and overhead pool for a month, with where each came from (manual, the month's statement,
    an earlier statement month, or none)."""
    loaded = [m for m in lines_by_month if m <= month]
    basis_month = max(loaded) if loaded else None
    lines = lines_by_month.get(basis_month, {}) if basis_month else {}
    source = None if basis_month is None else ("statement" if basis_month == month else f"statement {basis_month.isoformat()[:7]}")
    wages = lines.get("wages") or 0.0
    rate = sum(lines.get(line, 0.0) for line in cfg["burden"]["lines"]) / wages if wages else None
    pool = sum(lines.get(line, 0.0) for line in cfg["overhead"]["lines"]) if lines else None
    override = overrides.get(month, {})
    out = {"burden_rate": rate, "burden_source": source if rate is not None else None,
           "overhead_pool": pool, "overhead_source": source if pool is not None else None}
    if override.get("burden_rate") is not None:
        out["burden_rate"], out["burden_source"] = override["burden_rate"], "manual"
    if override.get("overhead_pool") is not None:
        out["overhead_pool"], out["overhead_source"] = override["overhead_pool"], "manual"
    return out


def apply(cursor: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add alloc_management, alloc_burden, alloc_overhead (weekly dollars) to job-week rows. Rows must carry
    labor, hours, revenue_month, revenue_month_amount (after parent-billing allocation) and _mgmt_month."""
    cfg = settings_of(cursor)
    months = {r["revenue_month"] if isinstance(r["revenue_month"], date) else date.fromisoformat(str(r["revenue_month"]))
              for r in rows if r.get("revenue_month")}
    lines_by_month, overrides = statement(cursor), manual(cursor)
    figures = {m: month_figures(m, cfg, lines_by_month, overrides) for m in months}
    week_totals: dict[str, dict[str, float]] = {}
    if cfg["overhead"]["enabled"]:
        weeks = sorted({str(r["week_start"]) for r in rows})
        cursor.execute(
            "SELECT week_start, sum(revenue_month_amount) AS revenue, sum(labor) AS labor, sum(hours) AS hours "
            "FROM mart.leadership_week WHERE week_start = ANY(%s::date[]) GROUP BY week_start",
            (weeks,),
        )
        week_totals = {str(r["week_start"]): {k: float(r[k] or 0) for k in ("revenue", "labor", "hours")} for r in cursor.fetchall()}
    for r in rows:
        month = r.get("revenue_month")
        month = (month if isinstance(month, date) else date.fromisoformat(str(month))) if month else None
        fig = figures.get(month, {}) if month else {}
        labor = float(r.get("labor") or 0)
        r["alloc_management"] = round(float(r.get("_mgmt_month") or 0) / DIVISOR, 2) if cfg["management_wages"]["enabled"] else 0.0
        rate = fig.get("burden_rate")
        r["alloc_burden"] = round(labor * rate, 2) if cfg["burden"]["enabled"] and rate else 0.0
        pool = fig.get("overhead_pool")
        share = 0.0
        if cfg["overhead"]["enabled"] and pool:
            basis = cfg["overhead"]["basis"]
            total = week_totals.get(str(r["week_start"]), {}).get(basis, 0.0)
            mine = r.get("revenue_month_amount") if basis == "revenue" else r.get(basis)
            share = float(mine or 0) / total if total else 0.0
        r["alloc_overhead"] = round(pool / DIVISOR * share, 2) if pool and share else 0.0
        r.pop("_mgmt_month", None)
    return rows


def overview(cursor: Any, months: list[date]) -> list[dict[str, Any]]:
    """Per month: burden rate and overhead pool (with sources), manual overrides, whether a statement
    is loaded, and the management wages on job cost. For Admin > Allocations."""
    cfg = settings_of(cursor)
    lines_by_month, overrides = statement(cursor), manual(cursor)
    cursor.execute("SELECT month, sum(management_wages) AS mgmt FROM mart.v_job_cost_month_effective WHERE month = ANY(%s) GROUP BY month",
                   (months,))
    mgmt = {r["month"]: _f(r["mgmt"]) for r in cursor.fetchall()}
    out = []
    for m in months:
        fig = month_figures(m, cfg, lines_by_month, overrides)
        out.append({"month": m.isoformat(), **fig, "management_wages": mgmt.get(m),
                    "manual_burden_rate": overrides.get(m, {}).get("burden_rate"), "manual_overhead_pool": overrides.get(m, {}).get("overhead_pool"),
                    "statement_loaded": m in lines_by_month})
    return out


def set_month(cursor: Any, month: date, burden_rate: float | None, overhead_pool: float | None, actor: str) -> None:
    if burden_rate is None and overhead_pool is None:
        cursor.execute("DELETE FROM ops.allocation_month WHERE month = %s", (month,))
        return
    cursor.execute(
        """
        INSERT INTO ops.allocation_month (month, burden_rate, overhead_pool, updated_by) VALUES (%s, %s, %s, %s)
        ON CONFLICT (month) DO UPDATE SET burden_rate = EXCLUDED.burden_rate, overhead_pool = EXCLUDED.overhead_pool,
          updated_at = now(), updated_by = EXCLUDED.updated_by
        """,
        (month, None if burden_rate is None else Decimal(str(burden_rate)), None if overhead_pool is None else Decimal(str(overhead_pool)), actor),
    )
