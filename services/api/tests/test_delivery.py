"""Delivery model resolution (app/delivery.py, migrations 066 and 067)."""
from __future__ import annotations

from app import delivery

SELF, SUB = delivery.SELF, delivery.SUB


def ev(**kw):
    base = {"override": None, "hours_recent": 0, "labor_window": 0, "ever_punched": False, "sub_ap": 0, "relay_ap": 0,
            "relay_sub": False, "relay_self": False, "job_cost_sub": 0, "delivery_declared": None}
    return {**base, **kw}


def r(**kw):
    return delivery.resolve(ev(**kw), 8, 40.0)


def test_defaults_when_the_setting_is_missing_or_malformed():
    assert delivery.config(None) == (8, 40.0, 92)
    assert delivery.config({"weeks": "x", "min_hours": None, "subcontract_days": "y"}) == (8, 40.0, 92)
    assert delivery.config({"weeks": -3, "min_hours": -1, "subcontract_days": 0}) == (0, 0.0, 1)
    assert delivery.config({"weeks": 8, "min_hours": 40}) == (8, 40.0, 92)        # 066's setting still reads


def test_override_beats_every_rule():
    assert r(override=SUB, hours_recent=5000) == (SUB, "override")
    assert r(override=SELF, relay_sub=True, sub_ap=900) == (SELF, "override")


def test_punched_sites_are_self_performed_whatever_the_export_says():
    # LGB3 / BDL3: Crane punches thousands of hours; the export said subcontracted.
    assert r(hours_recent=12000, delivery_declared=SUB, relay_sub=True) == (SELF, "hours")


def test_a_paid_subcontractor_without_punches_is_subcontracted_whatever_the_export_says():
    # FedEx Klamath Falls 523: export self-performed, Relay pays ServiceMaster, no punches.
    assert r(delivery_declared=SELF, relay_ap=633.0, relay_sub=True, job_cost_sub=633.0) == (SUB, "relay")
    assert r(delivery_declared=SELF, sub_ap=1200.0) == (SUB, "subcontractor_ap")
    assert r(delivery_declared=SELF, job_cost_sub=300.0) == (SUB, "job_cost")
    assert r(delivery_declared=SELF, relay_sub=True) == (SUB, "relay")


def test_a_small_self_performed_site_with_an_occasional_vendor_stays_self_performed():
    # Smiles Forever: 41 hours in 3 months ($893) under the 40-hours-in-8-weeks bar, a $150 vendor.
    assert r(hours_recent=30, labor_window=893.0, sub_ap=150.0, ever_punched=True) == (SELF, "labor_over_subcontract")
    assert r(hours_recent=4, labor_window=90.0, sub_ap=4000.0, ever_punched=True) == (SUB, "subcontractor_ap")


def test_relay_self_perform_then_declared_then_fallback():
    assert r(relay_self=True, delivery_declared=SUB) == (SELF, "relay")
    assert r(delivery_declared=SUB) == (SUB, "declared")
    assert r(ever_punched=True) == (SELF, "fallback")
    assert r() == (SUB, "fallback")


def test_weeks_zero_skips_the_hours_rule():
    assert delivery.resolve(ev(hours_recent=5000, delivery_declared=SUB), 0, 40.0) == (SUB, "declared")


class Cursor:
    def __init__(self, setting, rows):
        self.setting, self.rows, self.calls, self.many = setting, rows, [], []
        self._out = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if "key = %s" in sql:
            self._out = [] if self.setting is None else [{"value": self.setting}]
        elif "subcontractor_vendor_type_ids" in sql:
            self._out = [{"value": [6, 9]}]
        else:
            self._out = self.rows

    def executemany(self, sql, rows):
        self.many.append((sql, rows))

    def fetchone(self):
        return self._out[0] if self._out else None

    def fetchall(self):
        return self._out


def test_apply_writes_only_what_changed_with_its_basis():
    rows = [
        {**ev(relay_ap=633.0, relay_sub=True, delivery_declared=SELF), "job_key": 1, "company": "Crane IFS",
         "job_number": "523", "delivery_model": SELF, "delivery_basis": "declared"},
        {**ev(hours_recent=900), "job_key": 2, "company": "Crane West", "job_number": "500",
         "delivery_model": SELF, "delivery_basis": "hours"},
    ]
    c = Cursor({"weeks": 8, "min_hours": 40, "subcontract_days": 60}, rows)
    changed = delivery.apply(c)
    assert changed == [{"job_key": 1, "company": "Crane IFS", "job_number": "523", "from": SELF, "to": SUB, "basis": "relay"}]
    params = c.calls[-1][1]
    assert params == {"hours_days": 56, "sub_days": 60, "type_ids": ["6", "9"]}
    assert len(c.many) == 1 and "delivery_basis" in c.many[0][0]


def test_evidence_query_covers_every_current_job_and_keeps_relay_off_sarus():
    sql = delivery.EVIDENCE_SQL
    assert "valid_to IS NULL" in sql and "ops.job_delivery_override" in sql
    assert sql.count("IS DISTINCT FROM 'Sarus'") == 3
