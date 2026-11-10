"""An account's GL net profit with workers' comp and Finance's adjustments (no database)."""
from __future__ import annotations

from datetime import date, datetime

from app import gl_profit

SEP, OCT = date(2026, 9, 1), date(2026, 10, 1)
JOBS = {"800", "801"}


def adj(**kw):
    return {"adjustment_id": 1, "kind": "accrual", "category": "supplies", "amount": 100.0, "month": OCT, "to_job": "801",
            "from_job": None, "reverse_month": None, "cleared_at": None, "description": "x"} | kw


def test_accruals_count_in_their_month_and_reverse_later():
    e = gl_profit.adjustment_effects([adj(), adj(adjustment_id=2, category="subcontractors", amount=98670.0, month=SEP, reverse_month=OCT),
                                      adj(adjustment_id=3, category="revenue", amount=50.0), adj(adjustment_id=4, to_job="999"),
                                      adj(adjustment_id=5, cleared_at=datetime(2026, 11, 1))], JOBS)
    assert [a["effect"] for a in e[SEP]] == [-98670.0]
    assert sorted(a["effect"] for a in e[OCT]) == [-100.0, 50.0, 98670.0]


def test_a_reclass_counts_only_across_the_account_boundary():
    inside = adj(kind="reclass", from_job="800", to_job="801")
    into = adj(kind="reclass", from_job="999", to_job="801")
    out = adj(kind="reclass", from_job="800", to_job="999")
    e = gl_profit.adjustment_effects([inside, into, out], JOBS)
    assert sorted(a["effect"] for a in e[OCT]) == [-100.0, 100.0]


def test_months_add_workers_comp_where_the_statement_has_none():
    statement = {SEP: {"revenue": 1037651, "wages": 900000, "management_wages": 100000, "net_profit": -200000},
                 OCT: {"revenue": 1132353, "wages": 800000, "workers_comp": 48000, "net_profit": 30189},
                 date(2026, 11, 1): {"revenue": 1}}
    out = gl_profit.months(statement, {OCT: [{"effect": -25237.0}]}, 0.06)
    assert [m["month"] for m in out] == ["2026-09-01", "2026-10-01"]
    assert out[0]["workers_comp_added"] == -60000.0 and out[0]["adjusted_net_profit"] == -260000.0
    assert out[1]["workers_comp_added"] == 0.0 and out[1]["adjusted_net_profit"] == round(30189 - 25237, 2)


def test_rate_setting_falls_back_to_six_percent():
    assert gl_profit.rate_of({"workers_comp_rate": 0.05}) == 0.05
    assert gl_profit.rate_of(None) == 0.06 and gl_profit.rate_of({"workers_comp_rate": "x"}) == 0.06 and gl_profit.rate_of({"workers_comp_rate": 2}) == 0.06


def test_cross_tab_lines_make_a_statement():
    rows = [{"month": OCT, "category": "revenue", "workers_comp": False, "amount": 1132353},
            {"month": OCT, "category": "direct_labor", "workers_comp": False, "amount": 873546},
            {"month": OCT, "category": "payroll_taxes_insurance", "workers_comp": True, "amount": 52000},
            {"month": OCT, "category": "supplies", "workers_comp": False, "amount": 40000}]
    st = gl_profit.cross_tab_statement(rows)[OCT]
    assert st["net_profit"] == 1132353 - 873546 - 52000 - 40000 and st["wages"] == 873546 and st["workers_comp"] == 52000
    out = gl_profit.months({OCT: st}, {}, 0.06)
    assert out[0]["source"] == "cross_tab" and out[0]["workers_comp_added"] == 0.0
