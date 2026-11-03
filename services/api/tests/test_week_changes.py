"""Why labor changed week over week (app/week_changes.py): the effects add up, and Claude only reads the facts."""
from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace

import pytest

from app import week_changes as wc

CUR, PRIOR = date(2026, 10, 26), date(2026, 10, 19)


def row(week: date, job: str, labor: float, hours: float, ot: float = 0, otd: float = 0, **kw) -> dict:
    return {"week_start": week.isoformat(), "company": "Crane IFS", "job_number": job, "site_name": f"Site {job}", "role": "site", "segment": "Ground",
            "labor": labor, "hours": hours, "ot_hours": ot, "ot_dollars": otd, "sub_week": 0, "employees": 5, "days_with_labor": 7, "labor_basis": "payroll_rate", "delivery_model": "self_perform", **kw}


def test_the_effects_add_up_to_the_change_exactly():
    rows = [row(PRIOR, "1", 1000, 50, 5, 150), row(CUR, "1", 1400, 60, 10, 330),
            row(PRIOR, "2", 500, 25), row(CUR, "3", 300, 15), row(PRIOR, "4", 800, 40), row(CUR, "4", 700, 40, sub_week=100)]
    facts = wc.compute(rows, CUR, vendor_factor=0.7)
    assert facts["change"] == pytest.approx(sum(facts["effects"].values()), abs=0.02)
    assert facts["change"] == pytest.approx((1400 + 300 + 700 + 70) - (1000 + 500 + 800), abs=0.01)
    assert facts["effects"]["started"] == 300 and facts["effects"]["stopped"] == -500 and facts["effects"]["vendor"] == 70
    one = next(s for s in facts["sites"] if s["job_number"] == "1")
    assert one["effects"]["ot_premium"] == pytest.approx((330 - 150) / 3, abs=0.01)
    assert one["effects"]["hours"] == pytest.approx(10 * (1000 - 50) / 50, abs=0.01)  # 10 more hours at the prior base rate of $19
    assert sum(one["effects"].values()) == pytest.approx(one["change"], abs=0.02)


def test_scope_matches_the_labor_figure():
    rows = [row(CUR, "1", 1000, 50), row(CUR, "2", 400, 20, role="non_billed"), row(CUR, "3", 600, 30, delivery_model="subcontracted"),
            row(CUR, "31", 100, 5, role="pallet", parent_job_number="3"), row(CUR, "4", 0, 0, delivery_model=None, sub_week=50)]
    assert wc.compute(rows, CUR, split_subcontracted=True)["current"]["labor"] == 1000
    assert wc.compute(rows, CUR, split_subcontracted=False)["current"]["labor"] == 1000 + 600 + 100


def test_a_labor_source_change_and_a_rebound_are_called_out():
    rows = [row(date(2026, 9, 28), "1", 1000, 50), row(date(2026, 10, 5), "1", 1000, 50), row(date(2026, 10, 12), "1", 1000, 50),
            row(PRIOR, "1", 800, 40), row(CUR, "1", 1000, 50, labor_basis="pay_report")]
    facts = wc.compute(rows, CUR)
    assert facts["source_changes"] == {"sites": 1, "change": 200.0, "transitions": {"payroll_rate to pay_report": 1}}
    assert facts["average_prior"] == 950 and facts["prior_vs_average_pct"] < 0 < facts["vs_average_pct"]


def test_holidays_in_a_week():
    assert wc.holidays_in(date(2026, 9, 7)) == ["Labor Day"]
    assert wc.holidays_in(date(2026, 11, 23)) == ["Thanksgiving"]
    assert wc.holidays_in(date(2026, 12, 28)) == ["New Year's Day"]
    assert wc.holidays_in(date(2026, 10, 26)) == []


def test_the_model_input_is_stable_to_the_cent():
    a = wc.model_input("FedEx", wc.compute([row(PRIOR, "1", 1000.2, 50), row(CUR, "1", 1100.2, 55)], CUR))
    b = wc.model_input("FedEx", wc.compute([row(PRIOR, "1", 1000.21, 50), row(CUR, "1", 1100.19, 55)], CUR))
    assert a == b and json.loads(a)["labor"]["change"] == 100


def _response(text: str, stop: str = "end_turn") -> SimpleNamespace:
    return SimpleNamespace(stop_reason=stop, model="claude-opus-5-5", content=[SimpleNamespace(type="text", text=text)])


def test_summarize_uses_fallbacks_and_structured_output_and_rejects_refusals():
    calls = []

    class Client:
        class beta:
            class messages:
                @staticmethod
                def create(**kw):
                    calls.append(kw)
                    return _response(json.dumps({"headline": "More hours", "drivers": [{"title": "x", "detail": "y", "tone": "increase", "sites": []}] * 7, "check_next": ["a"] * 5}))

    out = wc.summarize("{}", "claude-opus-5-5", Client)
    assert len(out["drivers"]) == 5 and len(out["check_next"]) == 3 and out["served_by"] == "claude-opus-5-5"
    assert calls[0]["fallbacks"] == "default" and calls[0]["betas"] == ["server-side-fallback-2026-07-01"] and calls[0]["output_config"]["format"]["schema"] is wc.SCHEMA

    class Refuses:
        class beta:
            class messages:
                @staticmethod
                def create(**kw):
                    return _response("", "refusal")

    with pytest.raises(RuntimeError):
        wc.summarize("{}", "claude-opus-5-5", Refuses)


def test_a_week_in_progress_is_never_sent_to_the_model(monkeypatch):
    monkeypatch.setattr(wc, "settings", SimpleNamespace(anthropic_api_key="k", feedback_summary_model="m"))
    monkeypatch.setattr(wc, "refresh", lambda *a: pytest.fail("called the model"))
    facts = wc.compute([row(PRIOR, "1", 1000, 50), row(CUR, "1", 300, 15)], CUR)
    assert wc.state(None, "fedex", "FedEx", facts, complete=False) == {"status": "none"}
