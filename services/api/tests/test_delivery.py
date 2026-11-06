"""Delivery model from punches (app/delivery.py, migration 066)."""
from __future__ import annotations

from app import delivery


class Cursor:
    def __init__(self, setting):
        self.setting, self.calls, self._rows = setting, [], []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if "FROM ops.app_setting" in sql:
            self._rows = [] if self.setting is None else [{"value": self.setting}]
        else:
            self._rows = [{"company": "Crane West", "job_number": "500", "job_name": "Amazon - LGB3"}]

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def test_defaults_when_the_setting_is_missing_or_malformed():
    assert delivery.config(None) == (8, 40.0)
    assert delivery.config({"weeks": "x", "min_hours": None}) == (8, 40.0)
    assert delivery.config({"weeks": -3, "min_hours": -1}) == (0, 0.0)


def test_worked_sites_become_self_performed():
    c = Cursor({"weeks": 8, "min_hours": 40})
    assert delivery.apply(c) == [{"company": "Crane West", "job_number": "500", "job_name": "Amazon - LGB3"}]
    sql, params = c.calls[-1]
    assert params == {"days": 56, "min_hours": 40.0}
    assert "SET delivery_model = 'self_perform'" in sql and "valid_to IS NULL" in sql


def test_the_rule_never_marks_anything_subcontracted():
    assert "'subcontracted'" not in delivery.SQL


def test_weeks_zero_turns_it_off():
    c = Cursor({"weeks": 0})
    assert delivery.apply(c) == [] and len(c.calls) == 1
