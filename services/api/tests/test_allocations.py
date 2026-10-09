"""Corporate allocations (app/allocations.py) and the company month flags, without a database."""
from __future__ import annotations

from datetime import date

import pytest

from app import allocations
from app.routers.leadership import flag_spikes, is_closed

CFG = allocations.DEFAULT_SETTINGS


def test_month_figures_come_from_the_statement_carry_forward_and_yield_to_manual():
    lines = {date(2026, 6, 1): {"wages": 500000.0, "payroll_taxes": 40000.0, "workers_comp": 10000.0, "admin": 120000.0}}
    june = allocations.month_figures(date(2026, 6, 1), CFG, lines, {})
    assert june == {"burden_rate": 0.1, "burden_source": "statement", "overhead_pool": 120000.0, "overhead_source": "statement"}
    july = allocations.month_figures(date(2026, 7, 1), CFG, lines, {})
    assert july["burden_rate"] == 0.1 and july["burden_source"] == "statement 2026-06"
    manual = allocations.month_figures(date(2026, 7, 1), CFG, lines, {date(2026, 7, 1): {"burden_rate": 0.12, "overhead_pool": None}})
    assert (manual["burden_rate"], manual["burden_source"], manual["overhead_source"]) == (0.12, "manual", "statement 2026-06")
    assert allocations.month_figures(date(2026, 5, 1), CFG, lines, {})["burden_rate"] is None  # nothing loaded yet


class Cursor:
    """Answers the three queries apply() makes when the basis is revenue."""

    def __init__(self, statement, overrides=None, revenue=None, settings=None):
        self.statement, self.overrides, self.revenue, self.settings = statement, overrides or {}, revenue or {}, settings
        self.last = ""

    def execute(self, sql, params=None):
        self.last = sql

    def fetchone(self):
        return {"value": self.settings} if self.settings else None

    def fetchall(self):
        if "fact_company_income_statement_month" in self.last:
            return [{"month": m, "line": k, "amount": v} for m, lines in self.statement.items() for k, v in lines.items()]
        if "allocation_month" in self.last:
            return [{"month": m, **v} for m, v in self.overrides.items()]
        if "FROM mart.leadership_week" in self.last:
            return [{"week_start": w, **v} for w, v in self.revenue.items()]
        return []


def test_apply_adds_weekly_management_burden_and_overhead():
    cursor = Cursor({date(2026, 8, 1): {"wages": 1000000.0, "payroll_taxes": 80000.0, "workers_comp": 20000.0, "admin": 433000.0}},
                    revenue={"2026-09-14": {"revenue": 5000000.0, "labor": 200000.0, "hours": 9000.0}})
    rows = [{"week_start": "2026-09-14", "revenue_month": "2026-08-01", "revenue_month_amount": 500000.0, "labor": 20000.0, "hours": 900,
             "_mgmt_month": 4330.0},
            {"week_start": "2026-09-14", "revenue_month": None, "revenue_month_amount": 0, "labor": 100.0, "hours": 5, "_mgmt_month": None}]
    out = allocations.apply(cursor, rows)
    assert out[0]["alloc_management"] == 1000.0  # 4,330 a month ÷ 4.33
    assert out[0]["alloc_burden"] == 2000.0  # 20,000 × 10%
    assert out[0]["alloc_overhead"] == 10000.0  # 433,000 ÷ 4.33 × 10% of the week's company revenue
    assert (out[1]["alloc_management"], out[1]["alloc_burden"], out[1]["alloc_overhead"]) == (0.0, 0.0, 0.0)
    assert "_mgmt_month" not in out[0]


def test_disabled_allocations_are_zero():
    settings = {"management_wages": {"enabled": False}, "burden": {"enabled": False}, "overhead": {"enabled": False}}
    cursor = Cursor({date(2026, 8, 1): {"wages": 1.0, "payroll_taxes": 1.0, "admin": 1.0}}, revenue={"2026-09-14": {"revenue": 1.0, "labor": 1.0, "hours": 1.0}}, settings=settings)
    out = allocations.apply(cursor, [{"week_start": "2026-09-14", "revenue_month": "2026-08-01", "revenue_month_amount": 1.0, "labor": 5.0, "hours": 1, "_mgmt_month": 10.0}])
    assert (out[0]["alloc_management"], out[0]["alloc_burden"], out[0]["alloc_overhead"]) == (0.0, 0.0, 0.0)


def test_settings_are_validated():
    with pytest.raises(ValueError, match="basis"):
        allocations.validate_settings({"overhead": {"basis": "square_feet"}})
    with pytest.raises(ValueError, match="lines"):
        allocations.validate_settings({"burden": {"lines": "payroll_taxes"}})
    assert allocations.validate_settings({"overhead": {"basis": "hours"}})["overhead"]["basis"] == "hours"


def test_a_month_far_above_the_usual_share_is_flagged_and_growth_is_not():
    # Revenue and subcontractors both grow (not flagged); the last month's sub cost is 48% of revenue (flagged).
    months = [{"closed": True, "revenue": r, "subcontractors": s, "direct_labor": r * 0.55}
              for r, s in ((2_700_000, 190_000), (4_600_000, 376_000), (5_400_000, 380_000), (5_600_000, 698_000), (5_760_000, 2_776_000))]
    flag_spikes(months)
    assert [m["flags"] for m in months] == [[], [], [], [], ["sub_spike"]]


def test_a_month_with_cost_on_jobs_without_revenue_is_not_closed():
    # Jul 2026: $5.76M revenue, $2.96M of cost on jobs whose revenue had not posted (open); Jun 2026: 5.9% (closed).
    month = lambda revenue, unbilled, labor=0.55, tk=0.0: {"revenue": revenue, "direct_labor": revenue * labor, "timekeeping_labor": tk, "unbilled_cost": unbilled}
    assert is_closed(month(5_605_215, 331_239))
    assert not is_closed(month(5_758_735, 2_958_519))
    assert not is_closed(month(6_150_694, 1_743_863))
    assert not is_closed(month(0, 0))
    assert not is_closed(month(5_000_000, 0, tk=5_000_000))  # job cost labor under 70% of timekeeping


def test_a_weeks_overhead_adds_up_to_the_weekly_pool():
    cursor = Cursor({date(2026, 8, 1): {"admin": 433000.0}}, revenue={"2026-09-14": {"revenue": 3000.0, "labor": 1.0, "hours": 1.0}})
    rows = [{"week_start": "2026-09-14", "revenue_month": "2026-08-01", "revenue_month_amount": v, "labor": 1.0, "hours": 1, "_mgmt_month": None} for v in (1000.0, 2000.0)]
    out = allocations.apply(cursor, rows)
    assert sum(r["alloc_overhead"] for r in out) == 100000.0  # 433,000 ÷ 4.33, split 1:2
