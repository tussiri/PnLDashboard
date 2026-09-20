"""The per-job gate on the job-cost basis (app.marts, CTE jc_months / assembled).

A closed month's job-cost export is not guaranteed complete. When it omits a job, that job must
fall back to its own AR and timekeeping and say so, rather than being published at 0 revenue
against a full month of labor. The 2026-09-03 export understated July by 38.9% and August by 84.1%
under the old month-level gate.
"""
import re
from pathlib import Path

SQL = (Path(__file__).resolve().parents[1] / "app" / "marts.py").read_text()


def clause(name: str) -> str:
    """The CASE expression assigned to `name` in the assembled SELECT.

    Anchored on `END AS <name>` and walked back to the NEAREST preceding `CASE WHEN`; a forward
    non-greedy match starts at the first CASE in the file and swallows every clause before this one.
    """
    end = re.search(rf"END AS {name}\b", SQL)
    assert end, f"no END AS {name} found"
    start = SQL.rfind("CASE WHEN", 0, end.start())
    assert start != -1, f"no CASE WHEN precedes END AS {name}"
    return " ".join(SQL[start:end.end()].split())


def test_revenue_requires_a_job_cost_row_for_this_job():
    assert "jm.month IS NOT NULL AND jc.job_key IS NOT NULL" in clause("revenue")


def test_labor_cost_requires_a_job_cost_row_for_this_job():
    assert "jm.month IS NOT NULL AND jc.job_key IS NOT NULL" in clause("labor_cost")


def test_burden_is_applied_when_the_row_fell_back_to_timekeeping():
    """A job-cost row already carries burden; a timekeeping fallback row does not."""
    assert "jm.month IS NOT NULL AND jc.job_key IS NOT NULL" in clause("burden_cost")


def test_both_bases_name_what_the_row_actually_used():
    for name in ("revenue_basis", "labor_basis"):
        assert "jm.month IS NOT NULL AND jc.job_key IS NOT NULL" in clause(name), name


def test_ar_fallback_stays_reachable_inside_a_job_cost_month():
    """The whole defect was that 'ar_invoice' could never be reached once the month had any row."""
    assert "WHEN ar.job_key IS NOT NULL THEN 'ar_invoice'" in clause("revenue_basis")


def test_month_level_gate_alone_is_never_used_for_revenue_or_labor():
    for name in ("revenue", "labor_cost", "burden_cost", "revenue_basis", "labor_basis"):
        assert not re.search(r"CASE WHEN jm\.month IS NOT NULL THEN", clause(name)), name


def test_a_job_cost_row_is_only_taken_when_it_carries_revenue():
    """The export ships half-posted months as rows with revenue 0 and real labor. Taking those
    literally published $0 against AR WinTeam had already invoiced (job 500, Aug 2026: $517,334.27)."""
    assert "coalesce(jc.revenue, 0) <> 0" in clause("revenue")
    assert "coalesce(jc.revenue, 0) <> 0" in clause("revenue_basis")


def test_labor_still_comes_from_the_job_cost_row_when_one_exists():
    """Only revenue falls back. A zero-revenue row's labor is real and finance-approved, so the row
    legitimately carries revenue_basis = ar_invoice with labor_basis = job_cost."""
    assert "coalesce(jc.revenue, 0) <> 0" not in clause("labor_cost")


def test_has_jc_means_the_export_row_was_actually_used():
    """has_jc drives direct_cost and gross_profit. Left month-level it handed the export's own
    gross-profit figure to rows whose revenue came from AR, freezing portfolio gross profit at
    $8,025,438 while revenue rose $15.2M. It must match the revenue gate exactly."""
    line = next(l for l in SQL.splitlines() if "AS has_jc" in l)
    assert "jc.job_key IS NOT NULL" in line and "coalesce(jc.revenue, 0) <> 0" in line
