"""AR revenue the job-cost export leaves out (app/revenue_gap.py, migration 068)."""
from __future__ import annotations

from datetime import date

from app import revenue_gap


def test_config_defaults_off_and_bounds():
    assert revenue_gap.config(None) == (date(2026, 7, 1), None)
    assert revenue_gap.config({"from": "2026-07", "until": "2026-12-01"}) == (date(2026, 7, 1), date(2026, 12, 1))
    assert revenue_gap.config({"from": None}) == (None, None)
    assert revenue_gap.config({"from": "nonsense"}) == (None, None)


def test_sql_reconciles_per_parent_account_and_keeps_the_basis():
    sql = revenue_gap.SQL
    assert "parent_account_key" in sql and "GROUP BY 1, 2" in sql
    assert "least(1, g.gap / g.short)" in sql
    assert "revenue_basis = 'job_cost'" in sql and "SET revenue_basis" not in sql
    assert "gross_profit = m.gross_profit + a.amount" in sql and "revenue_ar_gap = a.amount" in sql


class Cursor:
    def __init__(self, setting, rows):
        self.setting, self.rows, self.calls, self._out = setting, rows, [], []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        self._out = ([{"value": self.setting}] if self.setting is not None else []) if "app_setting" in sql else self.rows

    def fetchone(self):
        return self._out[0] if self._out else None

    def fetchall(self):
        return self._out


def test_apply_sums_by_month_and_skips_when_off():
    rows = [{"month": date(2026, 7, 1), "amount": 100.0}, {"month": date(2026, 7, 1), "amount": 50.5},
            {"month": date(2026, 8, 1), "amount": 7.0}]
    c = Cursor({"from": "2026-07-01", "until": None}, rows)
    assert revenue_gap.apply(c) == {"2026-07": 150.5, "2026-08": 7.0}
    assert c.calls[-1][1] == {"from": date(2026, 7, 1), "until": None}
    off = Cursor({"from": None}, rows)
    assert revenue_gap.apply(off) == {} and len(off.calls) == 1
